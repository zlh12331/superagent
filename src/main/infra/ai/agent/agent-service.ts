// src/main/infra/ai/agent/agent-service.ts
// AgentService：Code Agent 核心服务，封装 streamText + tools + stopWhen 多轮工具调用循环
// ──────────────────────────────────────────────────────────────
// 职责：
// 1. 接收渲染层发起的 agent:run 请求，启动 streamText 流式响应（带工具调用能力）
// 2. 通过 ToolRegistry.toAISDKTools(ctx, executeHook) 转换工具为 AI SDK 原生格式
// 3. executeHook 注入 ToolExecutor.execute 作为权限检查 + 审批 + IPC 推送层
// 4. 使用 stopWhen: isStepCount(maxSteps) 限制多轮工具调用循环次数（AI SDK v7）
// 5. 把 result.toUIMessageStream() 的 part 逐个通过 IPC 推送到渲染层
// 6. 维护 sessionId → AbortController Map，支持中断指定/全部 agent 对话
// 7. 错误分类（复用 error-classifier）→ AppError → AGENT_STREAM_ERROR 推送
// 8. webContents.isDestroyed 守卫，避免销毁后继续推送
//
// 与 agent-runtime/ 的分工：
// - 本文件：回合编排宿主（XState 回合状态机、上下文压缩、落库、IPC 推送，感知 webContents/DB）
// - agent-runtime/：纯函数执行层（turn-runner 流翻译、循环检测、并发门，不感知 webContents/DB）
// - 错误分类复用 error-classifier.ts，错误 → AppError → AGENT_STREAM_ERROR 推送
//
// 与 AI SDK v7 的关系：
// - streamText 接收 tools 参数：Record<string, Tool>，AI SDK 自动多轮调用直到模型不再请求工具
// - stopWhen 接受 StopCondition（替代旧版 maxSteps）：isStepCount(n) 限制步数
// - result.toUIMessageStream() 返回 UIMessageStream，逐 part 含 text-delta/tool-call/tool-result/finish
// ──────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import type {
  AgentStreamEndPayload,
  AgentStreamErrorPayload,
  AgentStreamPartPayload,
  ChatMessage,
  TurnEndEvent,
  TurnEvent,
  TurnTextDeltaEvent,
  TurnToolResultEvent,
  TurnUsage,
} from '@code-agent/shared/main';
import { AppError, ErrorCode, IPC_DEFINITIONS, TurnEventType } from '@code-agent/shared/main';
import { isStepCount, streamText } from 'ai';
import type { WebContents } from 'electron';
import { emitEvent } from '../../../utils/emit-event';
import { logger } from '../../../utils/logger';
import type { ISessionService } from '../../storage/session-service';
import { withSpan } from '../../telemetry/otel';
import { createSdkTelemetryIntegration } from '../../telemetry/sdk-telemetry';
import { TurnEventEmitter } from '../agent-runtime';
import { combineAbortSignals, createTimeoutSignal } from '../agent-runtime/abort-utils';
import { ActiveSessionRegistry } from '../agent-runtime/active-session-registry';
import { createAgentTurnActor } from '../agent-runtime/agent-turn-machine';
import type { ConcurrencyGate } from '../agent-runtime/concurrency-gate';
import { createStreamWithRetry } from '../agent-runtime/create-stream';
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../agent-runtime/stream-reader';
import { TurnRunner } from '../agent-runtime/turn-runner';
import type { ITitleGenerator } from '../knowledge/session-title';
import {
  ensureSessionTitle,
  firstUserMessageText,
  lastUserMessageText,
} from '../knowledge/session-title';
import { getModel } from '../llm-client/ai-provider';
import type { LlmClient } from '../llm-client/llm-client';
import { buildGenerationOptions, modelRegistry } from '../models';
import type { IPromptService } from '../prompt/prompt-service';
import { classifyError, isAbortError } from '../tools/error-classifier';
import type { IPermissionService } from '../tools/permission-service';
import type { IToolExecutor } from '../tools/tool-executor';
import type { IToolRegistry } from '../tools/tool-registry';
import {
  compressByTokenBudget,
  estimateMessagesTokens,
  getCompactionBudget,
  getTokenBudgetDecision,
} from './context-compression';
import { createRepairToolCall } from './repair-tool-call';

/**
 * Agent 启动选项
 *
 * 与 StartChatOptions 的区别：
 * - 新增 workingDir：Code Agent 的工作目录约束（所有文件操作工具的根目录）
 * - 新增 systemPrompt：可选的系统提示词（覆盖默认行为）
 * - 新增 maxSteps：最大工具调用轮数（避免无限循环消耗 token）
 */
export interface StartAgentOptions {
  /** 完整消息历史（最后一条通常是 user 新消息） */
  readonly messages: ChatMessage[];
  /**
   * 可选 sessionId：续传已有 agent 对话时传入；省略则生成新 id
   *
   * 使用 `string | undefined` 而非 `?: string`：
   * exactOptionalPropertyTypes 严格模式下，调用方传 `{ sessionId: undefined }` 时
   * 显式声明 `| undefined` 才能接受 zod 推断的 `string | undefined` 类型。
   */
  readonly sessionId: string | undefined;
  /** 工作目录：限制所有文件操作工具在此目录内，防止 Agent 越权读写 */
  readonly workingDir: string;
  /** 可选系统提示词（覆盖默认 system prompt，定义 Agent 行为） */
  readonly systemPrompt: string | undefined;
  /** 最大工具调用轮数（默认 20，上限 50，避免无限循环） */
  readonly maxSteps: number;
  /** 思考强度（可选：渲染层设置项，覆盖模型级默认 reasoningEffort） */
  readonly thinking?: 'off' | 'low' | 'medium' | 'high';
  /** 采样温度（可选：渲染层设置项，覆盖模型级默认 generationConfig.temperature；思考模型忽略） */
  readonly temperature?: number;
  /** 运行模式（plan 只读探索 / build 审批后执行，缺省视为 build） */
  readonly mode?: 'plan' | 'build';
  /**
   * 接收流式 part 的 webContents（桌面窗口发起 agent:run 时传入）
   *
   * 可选：IM 桥接等无头场景不传（推送跳过、审批自动拒绝，
   * 由桥接层保证 approvalMode 为 auto/yolo 时才执行）。
   */
  readonly webContents?: WebContents;
}

/**
 * AgentService 接口
 *
 * 解耦 IPC handler 对具体类的依赖，便于：
 * - 单元测试：注入 mock 实现，不依赖真实 streamText / ToolExecutor
 * - 未来扩展：支持多 provider 路由、本地 LLM、批量 agent 等场景
 *
 * 与 IChatService 的接口对齐（abort/abortAll/dispose 模式一致），
 * 便于 ServiceContainer 统一管理生命周期。
 */
export interface IAgentService {
  /**
   * 启动一次 agent 对话
   *
   * 流程：
   * 1. 生成或复用 sessionId
   * 2. 创建 AbortController 并加入 Map
   * 3. 构造 ToolContext（含 workingDir / sessionId / abortSignal）
   * 4. 转换工具为 AI SDK 格式，注入 executeHook（ToolExecutor.execute）
   * 5. 调用 streamText 启动流式响应（带 tools + stopWhen）
   * 6. 异步读取 toUIMessageStream 的 reader，逐 part 通过 IPC 推送
   * 7. 流结束（正常/异常/abort）后从 Map 移除
   *
   * @returns 本次 agent 对话的 sessionId
   */
  startAgent(options: StartAgentOptions): Promise<string>;
  /** 中断指定 sessionId 的 agent 对话，返回是否成功中断 */
  abort(sessionId: string): boolean;
  /** 中断所有活跃 agent 对话（用于应用退出 / 窗口关闭场景） */
  abortAll(): void;
  /**
   * 是否存在活跃 agent 回合（关窗协商用）
   *
   * 窗口关闭前询问用户"回合运行中，确认中断退出"的判定依据；
   * 空注册表（无回合或已全部收尾）返回 false，不打扰正常退出。
   */
  hasActiveSessions(): boolean;
  /**
   * 优雅关闭：中断所有活跃 agent 对话并等待 stream 真正完成
   *
   * 与 IChatService.dispose 一致，用于应用退出场景。
   * - abortAll 仅同步触发 abort 信号，streamText 协程仍可能在 reader.read() 等待
   * - dispose 在 abortAll 后等待所有活跃 stream 真正进入 finally 块，带超时兜底
   *
   * @param timeoutMs 超时毫秒数（默认 3000ms）
   */
  dispose(timeoutMs?: number): Promise<void>;
  /**
   * 订阅全局回合事件（IM 桥接等跨会话监听方）
   *
   * 类级总线：任何会话的回合事件都会通知（回合内的事件发射器独立）。
   */
  onTurnEvent(listener: (event: TurnEvent) => void): () => void;
}

/**
 * AgentService 默认实现
 *
 * 依赖：
 * - IToolRegistry：转换为 AI SDK tools（toAISDKTools）
 * - IToolExecutor：作为 executeHook 注入，统一执行权限检查 + 审批 + IPC 推送
 * - IPromptService：当调用方未传 systemPrompt 时，自动解析默认 Code Agent prompt
 *
 * 单例模式：通过 ServiceContainer 持有，整个应用生命周期共享一个实例。
 * 内部维护 sessionId → AbortController + streamPromise 两个 Map（与 ChatService 一致）。
 */
export class AgentService implements IAgentService {
  /**
   * @param toolRegistry 工具注册表（用于 toAISDKTools）
   * @param toolExecutor 工具执行器（作为 executeHook 注入到 AI SDK tool.execute）
   * @param promptService Prompt 服务（用于在未传 systemPrompt 时解析默认 Code Agent prompt）
   */
  constructor(
    private readonly toolRegistry: IToolRegistry,
    private readonly toolExecutor: IToolExecutor,
    private readonly promptService: IPromptService,
    private readonly sessionService: ISessionService,
    /** 标题生成器（回合结束后异步生成会话标题，失败静默） */
    private readonly titleGenerator?: ITitleGenerator,
    /** 并发公平调度门（多会话共享执行槽位；未注入则无并发上限，测试兼容） */
    private readonly concurrencyGate?: ConcurrencyGate,
    /** 权限服务（审批生命周期 → 回合状态机 waitingApproval；未注入则跳过订阅） */
    private readonly permissionService?: IPermissionService,
    /**
     * LLM 客户端（工具入参自动修复引擎；未注入则不启用 repairToolCall）
     *
     * 用于 SDK v7 repairToolCall 钩子：LLM 生成非法工具入参时用轻量调用重生成。
     * 与工具执行链路（ToolExecutor）解耦，仅作为修复 side-query 出口。
     */
    private readonly llmClient?: LlmClient,
  ) {}

  /**
   * 活跃会话注册表（R2 去重：防重/中断/等待收尾逻辑收敛为共享实现，
   * 与 ChatService 同一语义，避免双处同步修正）
   */
  private readonly registry = new ActiveSessionRegistry();
  /** 类级回合事件监听器（onTurnEvent 注册；回合内转发） */
  private readonly turnListeners = new Set<(event: TurnEvent) => void>();

  /** @inheritDoc */
  onTurnEvent(listener: (event: TurnEvent) => void): () => void {
    this.turnListeners.add(listener);
    return () => {
      this.turnListeners.delete(listener);
    };
  }

  /** @inheritDoc */
  async startAgent(options: StartAgentOptions): Promise<string> {
    const sessionId = options.sessionId ?? randomUUID();

    // 防重检查（R2：收敛到共享注册表）：若同 sessionId 已有活跃 stream，
    // 先 abort 并等待其退出，避免孤儿 stream
    await this.registry.preemptExisting(sessionId, 'agent');

    const controller = new AbortController();

    // 回合状态机：标记进行中（崩溃恢复识别；正常结束在 stream finally 归位 idle）
    void this.sessionService.markRunning(sessionId).catch((err: unknown) => {
      logger.error({ sessionId, error: err }, 'markRunning 失败');
    });

    // 异步推送流式 part（不 await，让 startAgent 立即返回 sessionId）
    // 任何错误都通过 catch 推送 AGENT_STREAM_ERROR，不抛回调用方
    // catch 内部仅记录日志，不改变 Promise 状态（仍为 fulfilled），
    // 这样 dispose 的 Promise.allSettled 不会被 reject 影响
    const streamPromise = this.streamToWebContents(sessionId, options, controller).catch(
      (err: unknown) => {
        logger.error({ sessionId, error: err }, 'AgentService 流推送异常');
      },
    );
    this.registry.register(sessionId, controller, streamPromise);

    // R2：CAS 删除 stream 条目（语义内聚于共享注册表）
    streamPromise.finally(() => {
      this.registry.removeStreamIfCurrent(sessionId, streamPromise);
      // 回合状态机：stream 完全结束（正常/错误/中断）→ 归位 idle
      void this.sessionService.markIdle(sessionId).catch((err: unknown) => {
        logger.error({ sessionId, error: err }, 'markIdle 失败');
      });
    });

    return sessionId;
  }

  /** @inheritDoc */
  abort(sessionId: string): boolean {
    // R2：委托共享注册表（立即删除 controller 再 abort 的竞态语义内聚于此）
    return this.registry.abort(sessionId);
  }

  /** @inheritDoc */
  abortAll(): void {
    this.registry.abortAll();
  }

  /** @inheritDoc */
  hasActiveSessions(): boolean {
    return this.registry.activeCount > 0;
  }

  /** @inheritDoc */
  async dispose(timeoutMs = 3000): Promise<void> {
    // R2：委托共享注册表（abort 全部 + 等待 stream 完成 + 超时强制清空）
    await this.registry.dispose(timeoutMs);
  }

  /**
   * 流式推送实现：读取 toUIMessageStream 的 reader，逐 part 推送到 webContents
   *
   * 与 ChatService.streamToWebContents 的区别：
   * - 带 tools 参数（多轮工具调用）
   * - 带 stopWhen: isStepCount(maxSteps) 限制循环次数（AI SDK v7 替代 maxSteps）
   * - 带可选 system prompt（Code Agent 通常有系统提示词定义行为）
   * - executeHook 注入 ToolExecutor.execute 作为权限检查层
   *
   * 错误处理复用 error-classifier（与 ChatService 一致）：
   * - AbortError：用户主动中断，推送 reason='aborted' 的 AGENT_STREAM_END
   * - 其他错误：分类并推送 AGENT_STREAM_ERROR
   */
  private async streamToWebContents(
    sessionId: string,
    options: StartAgentOptions,
    controller: AbortController,
  ): Promise<void> {
    // 性能埋点：streamText 全流程耗时（含 prompt 解析 + 模型调用 + 工具执行 + 流推送）
    const startTime = performance.now();
    // OpenTelemetry span：串联 prompt 解析 → streamText → 工具执行 → 流推送整条链路
    await withSpan(
      'agent.streamText',
      {
        'session.id': sessionId,
        'agent.maxSteps': options.maxSteps,
        'agent.hasSystemPrompt': options.systemPrompt !== undefined,
      },
      async (span) => {
        // 回合事件上下文（try/catch/finally 共享：必须声明在 try 外，
        // catch/finally 是独立块级作用域，无法访问 try 内的 const）
        const turnEmitter = new TurnEventEmitter();
        const turnId = randomUUID();
        const turnStartTime = Date.now();
        // 回合状态机（XState）：回合执行层唯一状态权威；关键节点发送事件，
        // 非法转换被忽略（转换合法性由 agent-turn-machine.test 全表断言）
        const turnMachine = createAgentTurnActor({
          sessionId,
          turnId,
          modelId: modelRegistry.resolve(undefined).modelId,
          startedAt: turnStartTime,
        });
        // 审批生命周期订阅（waitingApproval 状态运行时数据源）：
        // 审批推送 → waitingApproval；决议完成 → 恢复 running（按 sessionId 过滤）
        const unsubscribeApproval = this.permissionService?.onApprovalLifecycle({
          onRequested: (p) => {
            if (p.sessionId === sessionId) {
              turnMachine.send({ type: 'approval.requested', approvalId: p.approvalId });
            }
          },
          onResolved: (p) => {
            if (p.sessionId === sessionId) {
              turnMachine.send({ type: 'approval.responded' });
            }
          },
        });
        // 模型级超时定时器（回合作用域；finally 清理）
        let modelTimeout: ReturnType<typeof createTimeoutSignal> | undefined;
        const resolvedModel = modelRegistry.resolve(undefined);
        // 类级事件转发（IM 桥接等跨会话监听方）：回合内所有事件同步转发
        const forwardTurnEvents = turnEmitter.onAny((event) => {
          for (const listener of this.turnListeners) {
            try {
              listener(event);
            } catch (err: unknown) {
              logger.error({ error: err }, '回合事件转发异常');
            }
          }
        });
        let unsubscribeAll = (): void => {};
        // 消息持久化累积（此前主链路从未落库 messages——重启后历史丢失）：
        // TEXT_DELTA 拼接助手全文；rawPartCount 统计流内原始 part（空回复检测）。
        // 声明在 try 外：catch 分支（错误/中断出口）同样需要读取代传递 completeTurn
        let assistantText = '';
        let rawPartCount = 0;
        // 并发公平调度：获取执行槽位（无空位时 FIFO 排队；排队期间 abort 走 AbortError 分类）
        let releaseGate: (() => void) | undefined;
        try {
          // 0. 并发槽位（回合执行开始前获取，释放见 finally）
          releaseGate =
            this.concurrencyGate === undefined
              ? undefined
              : await this.concurrencyGate.acquire(sessionId, controller.signal);
          // 回合状态机：槽位获取成功 → running
          turnMachine.send({ type: 'gate.ready' });
          // 1. 获取 model 实例（与 ChatService 一致，复用 ai-provider 单例）
          const model = await getModel(undefined);

          // 模型级容错（P0-1）：总时长超时（声明提升至回合作用域；有效信号组合）
          modelTimeout =
            resolvedModel.generationConfig?.timeoutMs !== undefined
              ? createTimeoutSignal(resolvedModel.generationConfig.timeoutMs)
              : undefined;
          const effectiveAbortSignal = combineAbortSignals([
            controller.signal,
            modelTimeout?.signal,
          ]);

          // 回合事件仅内部消费：类级监听器（onTurnEvent，供记忆捕获）与
          // TEXT_DELTA 累积（落库）订阅；不再向渲染层 IPC 推送——渲染层
          // 流式渲染走 agent:stream:part，回合历史走 session:getTurns 拉取
          unsubscribeAll = () => {
            unsubscribeTextAcc();
          };

          const unsubscribeTextAcc = turnEmitter.on(TurnEventType.TEXT_DELTA, (event) => {
            assistantText += (event as TurnTextDeltaEvent).text;
          });

          // 用户消息落库（回合开始）：失败静默（会话不存在/写入异常均不阻断对话；
          // try/catch 兜底测试桩返回非 Promise 等同步异常）
          const lastUserMessage = [...options.messages].reverse().find((m) => m.role === 'user');
          if (lastUserMessage !== undefined) {
            try {
              void this.sessionService
                .appendMessage({ sessionId, turnId, messages: [lastUserMessage] })
                .catch((err: unknown) => {
                  logger.error({ sessionId, error: err }, '用户消息落库失败');
                });
            } catch (err) {
              logger.error({ sessionId, error: err }, '用户消息落库失败（同步异常）');
            }
          }

          // 1.5 解析 System Prompt
          //     - 调用方传了 systemPrompt：直接用（用户显式覆盖）
          //     - 调用方未传 systemPrompt：调用 PromptService.resolvePrompt 注入默认 Code Agent prompt
          //       内部会从数据库读取模板 + 注入动态上下文（workingDir / git / AGENTS.md 等）
          //     - 失败容忍：PromptService 内部已处理回退（DB 失败 → 硬编码默认值）
          let systemPrompt = options.systemPrompt;
          if (systemPrompt === undefined) {
            const resolved = await this.promptService.resolvePrompt(undefined, options.workingDir);
            systemPrompt = resolved.content;
            logger.debug({ sessionId, source: resolved.source }, '已加载默认 Code Agent prompt');
          }

          // 2. 构造工具执行基础上下文（每次对话独立，闭包捕获 sessionId / workingDir / abortSignal / webContents）
          //    messageId / callId 由每次工具调用时动态填充
          //    mode：plan 模式下 ToolExecutor 会拒绝所有写操作（只读探索）
          //    userPrompt：权限决策用（意图豁免破坏性拦截）
          const userPrompt = lastUserMessageText(options.messages);
          const baseCtx = {
            workingDir: options.workingDir,
            sessionId,
            abortSignal: controller.signal,
            ...(options.webContents !== undefined ? { webContents: options.webContents } : {}),
            mode: options.mode ?? 'build',
            // 用户原始 prompt（权限决策：意图豁免破坏性拦截）
            ...(userPrompt !== undefined ? { userPrompt } : {}),
          };

          // 3. 转换工具为 AI SDK 格式，注入 executeHook（ToolExecutor.execute）
          //    executeHook 内部流程：
          //    - 调用 ToolExecutor.execute(toolName, toolCallId, input, ctx, webContents)
          //    - ToolExecutor 内部推送 AGENT_TOOL_CALL / AGENT_TOOL_RESULT 事件
          //    - ToolExecutor 内部处理权限检查 + 审批流程（permission='ask' 时）
          //    - 返回结果：成功时返回 output，失败时返回 { error } 对象给 LLM
          //
          //    失败时不抛错的设计理由：
          //    - 让 LLM 看到错误信息，自行决定下一步（重试 / 换工具 / 告知用户）
          //    - 抛错会中断整个 streamText，无法让 LLM 从错误中恢复
          //    - abortSignal 被触发时 streamText 会自动停止，无需靠抛错中断
          const tools = this.toolRegistry.toAISDKTools(baseCtx, async (tool, input, ctx) => {
            const toolStartTime = Date.now();
            const result = await this.toolExecutor.execute(
              tool.name,
              ctx.callId,
              input,
              ctx,
              options.webContents,
            );
            // 回合事件：工具执行结果（单一信息源：执行器侧信息最全）
            turnEmitter.emit({
              type: TurnEventType.TOOL_RESULT,
              sessionId,
              turnId,
              timestamp: Date.now(),
              toolCallId: ctx.callId,
              toolName: tool.name,
              success: result.error === undefined,
              ...(result.error !== undefined ? { error: result.error } : {}),
              ...(result.error === undefined ? { durationMs: Date.now() - toolStartTime } : {}),
            } satisfies TurnToolResultEvent);
            // 失败时返回结构化错误对象（让 LLM 看到错误信息）
            // 成功时返回 output（LLM 据此继续推理）
            if (result.error !== undefined) {
              return { error: result.error };
            }
            return result.output;
          });

          // 4. 启动 streamText（带 tools + stopWhen，自动多轮工具调用循环）
          //    AI SDK v7 用 stopWhen 替代旧版 maxSteps：
          //    - isStepCount(n) 创建步数限制条件，n 表示 LLM 调用工具的轮数上限
          //    - 超过 n 轮后 streamText 自动停止，避免无限循环消耗 token
          //
          //    system 参数：可选的系统提示词，覆盖 messages 中的 system 消息
          //    条件展开：systemPrompt 为 undefined 时不传 system 字段
          //    （exactOptionalPropertyTypes 要求可选字段不能显式传 undefined）
          // 上下文压缩：窗口感知预算（对齐 qwen compaction 阈值体系）
          // 预算 = 模型窗口 75% − 输出预留；默认窗口 128K（无能力元数据时兜底）
          const contextWindowSize = resolvedModel.capabilities.contextWindowSize ?? 128_000;
          // TokenBudget 回合级调度（对齐 qwen token-budget）：
          // - over-limit：上下文超硬上限 → 拒绝调用（防供应商 400）
          // - warn：接近压缩线 → 日志/遥测提醒（提前几轮缓冲）
          // - compact：达到压缩线 → 压缩消息历史（下方现有逻辑）
          const contextTokens = estimateMessagesTokens(options.messages);
          const budgetDecision = getTokenBudgetDecision(contextTokens, contextWindowSize);
          if (budgetDecision.level === 'over-limit') {
            logger.warn(
              {
                sessionId,
                contextTokens: budgetDecision.contextTokens,
                hardLimit: budgetDecision.hardLimit,
              },
              '上下文超出窗口硬上限，回合被拒绝',
            );
            throw new AppError(
              ErrorCode.AI_CONTEXT_TOO_LARGE,
              `上下文超出窗口上限（${budgetDecision.contextTokens} / ${budgetDecision.hardLimit} tokens），请新建会话或精简上下文`,
            );
          }
          if (budgetDecision.level === 'warn') {
            logger.warn(
              {
                sessionId,
                contextTokens: budgetDecision.contextTokens,
                compactAt: budgetDecision.compactAt,
              },
              '上下文接近压缩线（warn）',
            );
            span?.setAttribute('token.contextLevel', 'warn');
          }
          const compactionBudget = getCompactionBudget(contextWindowSize);
          const compressedMessages = compressByTokenBudget(options.messages, compactionBudget);
          if (compressedMessages.length < options.messages.length) {
            logger.info(
              {
                sessionId,
                originalCount: options.messages.length,
                compressedCount: compressedMessages.length,
              },
              '上下文已压缩',
            );
          }

          // 生成选项：思考强度 / 采样参数 / 输出上限（gpt-tokenizer 精确估算压缩后 prompt）
          // 用户思考强度档位覆盖模型级默认（'off' = 不注入 providerOptions）；
          // 用户温度覆盖模型级 generationConfig.temperature（思考模型忽略采样参数）
          const genOptions = buildGenerationOptions(
            resolvedModel,
            estimateMessagesTokens(compressedMessages),
            options.thinking,
            options.temperature,
          );

          // 5+6. 请求级重试：创建 + 首 part 读取（连接/认证/首包失败可重试；
          //    首 part 成功后不重试——流中错误重试会重复工具副作用）
          //
          //    重试分层（避免嵌套放大请求数）：
          //    - model call 级：SDK maxRetries（下方显式传入），每一步都生效，
          //      含工具调用之后的步骤；SDK 自带指数退避并尊重 retry-after 头
          //    - 请求级：createStreamWithRetry 只兜 SDK 覆盖不到的传输层失败
          const created = await createStreamWithRetry({
            create: () =>
              streamText({
                model,
                messages: compressedMessages,
                allowSystemInMessages: true,
                ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
                ...genOptions.samplingOptions,
                ...(genOptions.maxOutputTokens !== undefined
                  ? { maxOutputTokens: genOptions.maxOutputTokens }
                  : {}),
                ...(genOptions.providerOptions !== undefined
                  ? { providerOptions: genOptions.providerOptions }
                  : {}),
                tools,
                stopWhen: isStepCount(options.maxSteps),
                // model call 级重试真源：模型级 maxRetries（默认 2 次重试 = 3 次尝试）
                maxRetries: resolvedModel.generationConfig?.maxRetries ?? 2,
                ...(effectiveAbortSignal !== undefined
                  ? { abortSignal: effectiveAbortSignal }
                  : {}),
                // 工具入参自动修复（SDK v7 repairToolCall 钩子）：
                // LLM 生成非法工具入参（zod 校验失败）时用轻量 LLM 调用重生成，
                // 避免 parse 阶段失败导致工具调用静默丢弃。未注入 llmClient 时不启用。
                ...(this.llmClient !== undefined
                  ? {
                      repairToolCall: createRepairToolCall({
                        llmClient: this.llmClient,
                        modelId: resolvedModel.modelId,
                        ...(effectiveAbortSignal !== undefined
                          ? { signal: effectiveAbortSignal }
                          : {}),
                      }),
                    }
                  : {}),
                // 模型级遥测（SDK telemetry integration）：在回合 span 之下自动
                // 生成单次 LLM 调用 span（latency / usage / finishReason）。
                // integration 内部对未初始化 OTel（getTracer 为 null）判空跳过。
                telemetry: { integrations: [createSdkTelemetryIntegration()] },
              }),
            controller,
            // 请求级尝试次数走 createStreamWithRetry 默认值：与 SDK 的 model call
            // 级重试互不重叠（仅兜传输层失败），不再由 maxRetries 换算
          });
          const uiStream = created.stream;

          // 7. 回合执行（TurnRunner：读流 → 翻译 → 事件产出 → 统计）
          //    不感知 webContents / DB：事件经 emitter 产出，由订阅回调推送；
          //    流空闲超时在 TurnRunner 内守卫（复用 stream-reader）
          const runner = new TurnRunner({
            sessionId,
            turnId,
            modelId: resolvedModel.modelId,
            controller,
            emitter: turnEmitter,
            idleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
            // 请求级重试链路：首 part 已预读，TurnRunner 接续消费（复用 reader）
            firstPart: created.firstPart,
            // 原始 part 推送（AGENT_STREAM_PART 兼容通道；运行时对象为 SDK 完整 part）
            onPart: (part) => {
              rawPartCount += 1;
              if (options.webContents !== undefined && !options.webContents.isDestroyed()) {
                const payload: AgentStreamPartPayload = { sessionId, part };
                // dev 契约校验后发送（payloadSchema 见定义表）
                emitEvent(options.webContents, IPC_DEFINITIONS.agent.subscribeStreamPart, payload);
              }
            },
          });
          const runResult = await runner.run(uiStream as ReadableStream<unknown>, created.reader);

          // 回合状态机：流结束 → completed / aborted（TurnRunner 已归因）
          turnMachine.send(
            runResult.reason === 'completed'
              ? { type: 'stream.finished' }
              : { type: 'stream.aborted' },
          );

          // 模型级总时长超时检查：超时信号已触发 → 按 AI_TIMEOUT 归类（非用户中断）
          if (modelTimeout?.signal.aborted === true) {
            throw new AppError(ErrorCode.AI_TIMEOUT, '模型级响应总时长超时');
          }

          // 空回复防护：流「正常」结束但零 part（供应商对无效 Key/余额/模型名
          // 可能静默返回空流——此前用户侧表现为「发不出去」无任何提示）
          if (runResult.reason === 'completed' && rawPartCount === 0) {
            throw new AppError(
              ErrorCode.AI_EMPTY_RESPONSE,
              '模型返回了空回复，请检查 API Key 有效性、账户余额与模型名称',
            );
          }

          // 7+8. 结束处理：usage / AGENT_STREAM_END / turn-end / Transcript 落库
          if (runResult.reason === 'aborted') {
            logger.info({ sessionId }, 'Agent 对话被用户中断');
            span?.setAttribute('agent.aborted', true);
            this.completeTurn({
              sessionId,
              turnId,
              modelId: resolvedModel.modelId,
              reason: 'aborted',
              durationMs: runResult.durationMs,
              emitter: turnEmitter,
              ...(options.webContents !== undefined ? { webContents: options.webContents } : {}),
              assistantText,
            });
          } else {
            // totalUsage 是 PromiseLike（流结束后已 resolve），await 获取失败静默
            const usage = await Promise.resolve(created.result.totalUsage).catch(() => null);
            const turnUsage: TurnUsage | undefined =
              usage !== null && usage !== undefined
                ? {
                    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
                    ...(usage.outputTokens !== undefined
                      ? { outputTokens: usage.outputTokens }
                      : {}),
                    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
                    ...(usage.inputTokenDetails?.cacheReadTokens !== undefined
                      ? { cacheReadTokens: usage.inputTokenDetails.cacheReadTokens }
                      : {}),
                    ...(usage.outputTokenDetails?.reasoningTokens !== undefined
                      ? { reasoningTokens: usage.outputTokenDetails.reasoningTokens }
                      : {}),
                  }
                : undefined;

            // token 使用量统计（AI SDK v7 原生支持，免费数据）
            if (usage !== null && usage !== undefined) {
              logger.info(
                {
                  sessionId,
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  totalTokens: usage.totalTokens,
                },
                'Agent token 使用量',
              );
              // 用量持久化（设置页用量统计）：失败不阻断主流程
              void this.sessionService
                .recordUsage({
                  sessionId,
                  modelId: resolvedModel.modelId,
                  inputTokens: usage.inputTokens ?? 0,
                  outputTokens: usage.outputTokens ?? 0,
                  totalTokens: usage.totalTokens ?? 0,
                  cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
                  reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
                })
                .catch((err: unknown) => {
                  logger.error({ sessionId, error: err }, 'recordUsage 失败');
                });
              // setAttribute 不接受 undefined，需显式守卫
              if (usage.totalTokens !== undefined) {
                span?.setAttribute('token.total', usage.totalTokens);
              }
              if (usage.inputTokens !== undefined) {
                span?.setAttribute('token.prompt', usage.inputTokens);
              }
              if (usage.outputTokens !== undefined) {
                span?.setAttribute('token.completion', usage.outputTokens);
              }
            }

            this.completeTurn({
              sessionId,
              turnId,
              modelId: resolvedModel.modelId,
              reason: 'completed',
              durationMs: runResult.durationMs,
              // exactOptionalPropertyTypes：undefined 需条件展开
              ...(turnUsage !== undefined ? { usage: turnUsage } : {}),
              emitter: turnEmitter,
              ...(options.webContents !== undefined ? { webContents: options.webContents } : {}),
              assistantText,
            });
            // 标题生成（回合结束后异步，失败静默）：
            // 会话仍为默认标题时用首条用户消息生成简洁标题
            if (this.titleGenerator !== undefined) {
              void ensureSessionTitle({
                sessionService: this.sessionService,
                titleGenerator: this.titleGenerator,
                sessionId,
                firstUserText: firstUserMessageText(options.messages),
              });
            }
          }
        } catch (error: unknown) {
          // AbortError 是用户主动中断，不视为错误（推送 reason='aborted' 的 END）
          // 注：TurnRunner 内的中断已归为 aborted result；此处处理组装阶段
          // （streamText 调用）直接抛出的中断
          if (isAbortError(error)) {
            logger.info({ sessionId }, 'Agent 对话被用户中断');
            span?.setAttribute('agent.aborted', true);
            this.completeTurn({
              sessionId,
              turnId,
              modelId: resolvedModel.modelId,
              reason: 'aborted',
              durationMs: Date.now() - turnStartTime,
              emitter: turnEmitter,
              ...(options.webContents !== undefined ? { webContents: options.webContents } : {}),
              assistantText,
            });
          } else {
            // 其他错误：分类并推送 AGENT_STREAM_ERROR
            const appError = classifyError(error);
            // 回合状态机：异常 → error（带错误码上下文）
            turnMachine.send({
              type: 'stream.error',
              code: appError.code,
              message: appError.message,
            });
            if (options.webContents !== undefined && !options.webContents.isDestroyed()) {
              const errorPayload: AgentStreamErrorPayload = {
                sessionId,
                code: appError.code,
                message: appError.message,
              };
              emitEvent(
                options.webContents,
                IPC_DEFINITIONS.agent.subscribeStreamError,
                errorPayload,
              );
            }
            // 回合事件：error + turn-end（error）+ Transcript 落库
            turnEmitter.emit({
              type: TurnEventType.ERROR,
              sessionId,
              turnId,
              timestamp: Date.now(),
              code: appError.code,
              message: appError.message,
            } satisfies TurnEvent);
            this.completeTurn({
              sessionId,
              turnId,
              modelId: resolvedModel.modelId,
              reason: 'error',
              durationMs: Date.now() - turnStartTime,
              emitter: turnEmitter,
              ...(options.webContents !== undefined ? { webContents: options.webContents } : {}),
              assistantText,
            });
            logger.error(
              { sessionId, errorCode: appError.code, error: appError },
              'Agent 对话流异常结束',
            );
          }
        } finally {
          // 并发槽位释放（幂等；必须在超时定时器清理前完成，让排队的下个回合尽早启动）
          releaseGate?.();
          // 取消回合事件订阅（防泄漏）
          unsubscribeAll();
          forwardTurnEvents();
          // 取消审批生命周期订阅（回合结束；防泄漏）
          unsubscribeApproval?.();
          // 模型级超时定时器清理（请求结束立即释放，防长超时 × 高频调用堆积）
          modelTimeout?.clear();
          // CAS（Compare-And-Swap）删除 controller（R2：语义内聚于共享注册表）：
          // 仅当注册表里存的还是自己时才删——abort() 已删除 → startAgent 写入新
          // controller → 旧 stream finally 不误删新 controller。
          // stream 条目的 CAS 删除在 startAgent 的 .finally() 链中处理。
          this.registry.removeControllerIfCurrent(sessionId, controller);

          // 性能埋点：总耗时（从 streamText 开始到流推送完毕）
          const durationMs = Math.round(performance.now() - startTime);
          logger.info({ sessionId, durationMs }, 'Agent streamText 总耗时');
          span?.setAttribute('agent.durationMs', durationMs);
          span?.end();
        }
      },
    );
  }

  /**
   * 回合落库（Transcript）：失败不阻断主流程
   *
   * seq 取会话已有回合数（单会话串行执行，无并发冲突）。
   */
  private async persistTurn(turn: TurnEndEvent, modelId: string): Promise<void> {
    try {
      const { turns: existing } = await this.sessionService.getTurns(turn.sessionId);
      await this.sessionService.recordTurn({
        turnId: turn.turnId,
        sessionId: turn.sessionId,
        seq: existing.length,
        modelId,
        status: turn.reason,
        inputTokens: turn.usage?.inputTokens,
        outputTokens: turn.usage?.outputTokens,
        totalTokens: turn.usage?.totalTokens,
        durationMs: turn.durationMs,
      });
    } catch (err: unknown) {
      logger.error({ sessionId: turn.sessionId, error: err }, 'persistTurn 失败');
    }
  }

  /**
   * 统一回合收尾：turn-end 事件 + AGENT_STREAM_END 推送 + Transcript 落库
   *
   * 三个出口（completed / aborted / error）共用，消除重复。
   */
  private completeTurn(params: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly modelId: string;
    readonly reason: 'completed' | 'aborted' | 'error';
    readonly durationMs: number;
    readonly usage?: TurnUsage;
    readonly emitter: TurnEventEmitter;
    readonly webContents?: WebContents;
    /** 助手文本（TEXT_DELTA 累积；中断/错误回合保留已流出的部分） */
    readonly assistantText?: string;
  }): void {
    const turnEnd: TurnEndEvent = {
      type: TurnEventType.TURN_END,
      sessionId: params.sessionId,
      turnId: params.turnId,
      timestamp: Date.now(),
      reason: params.reason,
      durationMs: params.durationMs,
      ...(params.usage !== undefined ? { usage: params.usage } : {}),
    };
    params.emitter.emit(turnEnd);

    // AGENT_STREAM_END 推送（error 出口不推 END，已推 AGENT_STREAM_ERROR；
    // 无 webContents 的无头场景跳过推送）
    if (
      params.webContents !== undefined &&
      !params.webContents.isDestroyed() &&
      params.reason !== 'error'
    ) {
      const endPayload: AgentStreamEndPayload = {
        sessionId: params.sessionId,
        reason: params.reason,
        ...(params.usage !== undefined ? { usage: params.usage } : {}),
      };
      emitEvent(params.webContents, IPC_DEFINITIONS.agent.subscribeStreamEnd, endPayload);
    }

    // Transcript 落库（失败不阻断主流程）
    void this.persistTurn(turnEnd, params.modelId);

    // 助手消息落库（含中断/错误回合的已流出文本——历史不因失败丢失；
    // try/catch 兜底测试桩返回非 Promise 等同步异常）
    if (params.assistantText !== undefined && params.assistantText.length > 0) {
      try {
        void this.sessionService
          .appendMessage({
            sessionId: params.sessionId,
            turnId: params.turnId,
            messages: [{ role: 'assistant', content: params.assistantText }],
          })
          .catch((err: unknown) => {
            logger.error({ sessionId: params.sessionId, error: err }, '助手消息落库失败');
          });
      } catch (err) {
        logger.error({ sessionId: params.sessionId, error: err }, '助手消息落库失败（同步异常）');
      }
    }
  }
}
