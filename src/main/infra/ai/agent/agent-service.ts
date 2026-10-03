// src/main/infra/ai/agent/agent-service.ts
// AgentService：Code Agent 回合的宿主（生命周期编排 + 效果提供 + 落库 + 推送）
// ──────────────────────────────────────────────────────────────
// 在 38 号重构后的职责划分（改动前务必先读）：
// - **控制流不在这里**：模型解析/并发排队/回合执行/审批与提问等待/终态裁决
//   全部由 XState 状态机（agent-runtime/agent-turn-machine）驱动。本文件在
//   runTurnStream 内构造 TurnDeps（效果闭包）交给机器，机器在正确时机回调。
// - **本文件提供效果**：装配（模型/工具/提示词/预算）、流消费委托
//   turn-assembly、收尾（三个 finalize：completed/aborted/error）、
//   事件推送（part/END/ERROR）、落库（turns + messages 富 parts）。
// - **跨回合记账留在本文件**：活跃会话注册表、preempt 防重、TOCTOU 集合——
//   这些是「回合之间」的职责，不属于单回合机器。
//
// 与 agent-runtime/ 的分工：本文件感知 webContents/DB（副作用层）；
// agent-runtime/ 是纯函数执行层（turn-runner 流翻译、并发门、循环检测），
// 不感知窗口与数据库。
//
// 对外契约（IAgentService，勿改）：
// - startAgent(options) 立即返回 sessionId，回合在后台异步推进（不 await 完成）
// - abort / abortAll 中断；dispose 中断并等待收尾（带超时兜底）
// - onTurnEvent 订阅类级回合事件总线（IM 桥接等跨会话监听方）
//
// 错误处理：复用 error-classifier，错误 → AppError → AGENT_STREAM_ERROR 推送
// （AbortError 例外——用户中断不是错误，走 aborted 出口）。
// ──────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import type {
  AgentStreamEndPayload,
  AgentStreamErrorPayload,
  ChatMessage,
  TurnEndEvent,
  TurnEvent,
  TurnToolResultEvent,
  TurnUsage,
} from '@code-agent/shared/main';
import {
  AppError,
  ErrorCode,
  IPC_DEFINITIONS,
  TurnEventType,
  turnEndInvalidationDomains,
} from '@code-agent/shared/main';
import type { WebContents } from 'electron';
import { emitEvent } from '../../../utils/emit-event';
import { logger } from '../../../utils/logger';
import { broadcastInvalidation } from '../../invalidation/invalidation';
import type { ISessionService } from '../../storage/session-service';
import { withSpan } from '../../telemetry/otel';
import { TurnEventEmitter } from '../agent-runtime';
import { ActiveSessionRegistry } from '../agent-runtime/active-session-registry';
import { createAgentTurnActor, type TurnDeps } from '../agent-runtime/agent-turn-machine';
import type { ConcurrencyGate } from '../agent-runtime/concurrency-gate';
import type { TurnRunResult } from '../agent-runtime/turn-runner';
import type { TurnTranscriptEntry } from '../agent-runtime/turn-transcript';
import { buildAssistantTurnMessages } from '../agent-runtime/turn-transcript';
import type { ITitleGenerator } from '../knowledge/session-title';
import {
  ensureSessionTitle,
  firstUserMessageText,
  lastUserMessageText,
} from '../knowledge/session-title';
import type { LlmClient } from '../llm-client/llm-client';
// ⚠️ buildGenerationOptions 必须从 '../models' 桶出口导入：测试 mock 缝在该模块
// （vi.mock('../models')），直连 generation-options 会绕过 mock（实测 22 测试红）
import { buildGenerationOptions, modelRegistry } from '../models';
import type { GenerationOptions } from '../models/generation-options';
import type { ResolvedModel } from '../models/types';
import type { IPromptService, ResolvedPrompt } from '../prompt/prompt-service';
import { classifyError } from '../tools/error-classifier';
import type { IPermissionService } from '../tools/permission-service';
import type { Tool, ToolContext } from '../tools/tool';
import type { IToolExecutor } from '../tools/tool-executor';
import type { IToolRegistry } from '../tools/tool-registry';
// agentAskService 为模块级单例（与 cronService 同模式：非容器 accessor，
// 直接 import——见 AGENTS.md 架构说明）；测试下无 pending 时 expireAsk 为 no-op
import { agentAskService } from './agent-ask-service';
import {
  compressByTokenBudget,
  estimateMessagesTokens,
  getCompactionBudget,
  getTokenBudgetDecision,
} from './context-compression';
import { createTurnPartForwarder } from './stream-part-forward';
import { resolveTokenBudgetBasis } from './token-overhead';
import { assembleAndRunTurn } from './turn-assembly';
import {
  subscribeApprovalLifecycle,
  subscribeAskLifecycle,
  subscribeTurnAccumulators,
} from './turn-subscriptions';
import type { SdkTotalUsageLike } from './turn-usage-report';
import { projectTurnUsage, reportTurnUsage } from './turn-usage-report';

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
  /**
   * 预解析的基础 prompt（P2-32：调用方已 resolvePrompt 时传入复用，回合内免二次解析）
   *
   * 仅在 systemPrompt 未传时消费；agent.handler 的记忆召回链已解析基础 prompt
   * 用于拼接 <memory_context>，复用它避免重复读库 + git status 子进程 +
   * AGENTS.md 遍历。与 systemPrompt 独立：传了 systemPrompt 时本字段被忽略。
   */
  readonly resolvedPrompt?: ResolvedPrompt;
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
   * 启动一次 agent 回合
   *
   * 流程（38 号重构后）：
   * 1. 生成或复用 sessionId；TOCTOU 集合把「检查—注册」变原子（见 startingSessions）
   * 2. preempt 同 sessionId 的旧流（abort 并等其退出，避免孤儿流）
   * 3. markRunning（崩溃恢复识别）；fire-and-forget 启动 runTurnStream
   * 4. 注册 controller + streamPromise；返回 sessionId（**不等待回合完成**）
   * 5. 回合内的控制流由状态机驱动（见 runTurnStream 与 agent-turn-machine）
   *
   * @returns 本次 agent 对话的 sessionId（立即返回）
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
 * 依赖（全部经构造注入，测试可替换）：
 * - IToolRegistry：转换为 AI SDK tools（toAISDKTools）
 * - IToolExecutor：作为 executeHook 注入，统一执行权限检查 + 审批 + IPC 推送
 * - IPromptService：调用方未传 systemPrompt 时解析默认 Code Agent prompt
 * - ISessionService：回合落库（turns/messages）与 running/idle 状态维护
 * - 可选：titleGenerator / concurrencyGate / permissionService / llmClient
 *   （缺省时对应能力降级，见各构造参数注释）
 *
 * 生命周期：由 ServiceContainer 持有为单例（整个应用共享）。
 * 跨回合记账集中在两个成员：registry（活跃会话）+ startingSessions（启动临界区）。
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
  /**
   * 启动中的 sessionId 集合（2026-09-08 修复 startAgent 注册 TOCTOU）
   *
   * `await preemptExisting(...)` 与 `registry.register(...)` 之间跨越 await 边界：
   * 同 sessionId 的两次并发 startAgent 都会通过「无活跃」判定，再先后 register，
   * 后者覆盖前者 → 孤儿 controller/stream + 后续 persistTurn 的 seq 冲突。
   * 该 Set 在进入临界区时同步占用、注册完成后释放，把「检查—注册」变成原子操作。
   * （Node 单线程 + better-sqlite3 同步驱动，Set 操作间不会插入其他 await。）
   */
  private readonly startingSessions = new Set<string>();

  /** @inheritDoc */
  onTurnEvent(listener: (event: TurnEvent) => void): () => void {
    this.turnListeners.add(listener);
    return () => {
      this.turnListeners.delete(listener);
    };
  }

  /**
   * 解析基础 system prompt（P2-32）
   *
   * 调用方（agent.handler 记忆召回链）已 resolvePrompt 时直接复用；
   * 未传时按工作目录解析默认 Code Agent prompt（DB 失败内部回退硬编码默认）。
   */
  private resolveSystemPrompt(options: StartAgentOptions): Promise<ResolvedPrompt> {
    if (options.resolvedPrompt !== undefined) {
      return Promise.resolve(options.resolvedPrompt);
    }
    return this.promptService.resolvePrompt(undefined, options.workingDir);
  }

  /** @inheritDoc */
  async startAgent(options: StartAgentOptions): Promise<string> {
    const sessionId = options.sessionId ?? randomUUID();

    // 注册 TOCTOU 临界区（2026-09-08 修复）：同 sessionId 已在启动中则先等它结束。
    // 必要性：await preemptExisting 与 registry.register 之间跨越 await 边界，
    // 两次并发调用会都通过「无活跃」判定再先后 register，后者覆盖前者的
    // controller/stream（孤儿流 + persistTurn 的 seq 冲突）。
    // 用微任务轮询等待而非抛错：调用方语义是「启动/复用该会话的回合」，
    // 等完走正常 preempt 流程（中断前一个回合）比抛错更符合预期。
    while (this.startingSessions.has(sessionId)) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.startingSessions.add(sessionId);

    try {
      // 防重：同 sessionId 已有活跃 stream → abort 并等其退出（避免孤儿 stream）。
      // 语义内聚于共享注册表（R2），与 ChatService 同一实现
      await this.registry.preemptExisting(sessionId, 'agent');

      const controller = new AbortController();

      // 标记 running（崩溃恢复识别：启动期会把残留 running 标 interrupted）；
      // 归位 idle 在 handleStreamSettled（CAS 门控）。失败不阻断（仅记日志）
      void this.sessionService.markRunning(sessionId).catch((err: unknown) => {
        logger.error({ sessionId, error: err }, 'markRunning 失败');
      });

      // fire-and-forget 启动回合流：不 await，让 startAgent 立即返回 sessionId。
      // 这里 catch 兜住所有异常（只记日志、不 rethrow）——保证 streamPromise 恒为
      // fulfilled，dispose 的 Promise.allSettled 不会被 reject 干扰
      const streamPromise = this.runTurnStream(sessionId, options, controller).catch(
        (err: unknown) => {
          logger.error({ sessionId, error: err }, 'AgentService 流推送异常');
        },
      );
      this.registry.register(sessionId, controller, streamPromise);

      // 流收尾挂钩（CAS：仅当注册表里仍是本流时才归位 idle，见 handleStreamSettled）
      streamPromise.finally(() => {
        this.handleStreamSettled(sessionId, streamPromise);
      });

      return sessionId;
    } finally {
      // 临界区释放：注册完成（或异常）即放开，后续并发调用可走正常 preempt 路径
      this.startingSessions.delete(sessionId);
    }
  }

  /**
   * 流收尾：CAS 归位 idle
   *
   * 仅当本流仍是被注册的当前流时才 markIdle。必要性（2026-09-28 深读）：
   * preempt 兜底超时（5s）后新回合可能已 register + markRunning，旧流的迟到
   * 收尾若无条件 markIdle 会把 running 回退成 idle——仅 DB 持久层语义失真
   * （内存侧 registry 因 CAS 本就无误删），但会让崩溃恢复读到错误状态。
   */
  private handleStreamSettled(sessionId: string, streamPromise: Promise<void>): void {
    const isCurrent = this.registry.removeStreamIfCurrent(sessionId, streamPromise);
    if (!isCurrent) {
      return;
    }
    // 流完全结束（正常/错误/中断）→ 归位 idle
    void this.sessionService.markIdle(sessionId).catch((err: unknown) => {
      logger.error({ sessionId, error: err }, 'markIdle 失败');
    });
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
   * 用户消息落库（回合开始）：失败静默（会话不存在/写入异常均不阻断对话；
   * try/catch 兜底测试桩返回非 Promise 等同步异常）
   */
  private persistUserMessageQuietly(
    sessionId: string,
    turnId: string,
    options: StartAgentOptions,
  ): void {
    const lastUserMessage = [...options.messages].reverse().find((m) => m.role === 'user');
    if (lastUserMessage === undefined) {
      return;
    }
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

  /**
   * 工具执行钩子（executeHook）：ToolExecutor.execute 包装 + TOOL_RESULT 事件 + 转录
   *
   * 失败不抛错的设计理由：
   * - 让 LLM 看到错误信息，自行决定下一步（重试 / 换工具 / 告知用户）
   * - 抛错会中断整个 streamText，无法让 LLM 从错误中恢复
   * - abortSignal 被触发时 streamText 会自动停止，无需靠抛错中断
   */
  private buildToolExecuteHook(args: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly options: StartAgentOptions;
    readonly turnEmitter: TurnEventEmitter;
    readonly transcriptEntries: TurnTranscriptEntry[];
  }): (tool: Tool, input: unknown, ctx: ToolContext) => Promise<unknown> {
    const { sessionId, turnId, options, turnEmitter, transcriptEntries } = args;
    return async (tool, input, ctx) => {
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
      // 工具结果转录（output/error 在执行侧最全，与上方 TOOL_RESULT 事件同源）
      transcriptEntries.push({
        kind: 'tool-result',
        toolCallId: ctx.callId,
        toolName: tool.name,
        ...(result.error !== undefined ? { error: result.error } : { output: result.output }),
      });
      // 失败时返回结构化错误对象（让 LLM 看到错误信息）；成功时返回 output
      if (result.error !== undefined) {
        return { error: result.error };
      }
      return result.output;
    };
  }

  /**
   * 回合流驱动：构造效果面（TurnDeps）→ 创建并启动状态机 → 等终态
   *
   * 这是宿主与机器的**唯一接缝**：本方法不写控制流，只把「机器可能需要的能力」
   * 包成 deps 闭包（捕获 options/webContents/span/累积器/合帧器），机器在
   * 正确时机回调它们。控制流的权威在 agent-turn-machine（状态/guard 顺序/
   * exit-entry 顺序/终态收尾都在那边，见其文件头）。
   *
   * 与 ChatService.streamToWebContents 的区别：带 tools + stopWhen 限轮数、
   * executeHook 注入权限层、错误复用 error-classifier（Chat 无这些）。
   *
   * @param sessionId 会话 id（registry 记账键）
   * @param options 回合启动选项（消息/工作目录/模型参数/窗口）
   * @param controller 本回合的中断控制器（用户 abort / preempt 触发）
   */
  private async runTurnStream(
    sessionId: string,
    options: StartAgentOptions,
    controller: AbortController,
  ): Promise<void> {
    // 性能埋点：整回合耗时（含 prompt 解析 + 模型调用 + 工具执行 + 流推送）
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
        const turnEmitter = new TurnEventEmitter();
        const turnId = randomUUID();
        const turnStartTime = Date.now();
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
        // 消息持久化累积（宿主闭包持有——高频流数据不进机器，见机器文件头）：
        // TEXT_DELTA 拼接助手全文；rawPartCount 统计流内原始 part（空回复防护判据，
        // 经 turn.runDone 回传机器）；transcriptEntries 落库为富 parts（重开会话可见）
        let unsubscribeAll: () => void = () => {};
        let assistantText = '';
        const transcriptEntries: TurnTranscriptEntry[] = [];
        let rawPartCount = 0;
        // 原始 part 推送（P2-31：text-delta 按 sessionId 16–20ms 微批合帧；
        // flush 在各收尾路径推送 END/ERROR 前调用，保序防丢尾）
        const partForwarder = createTurnPartForwarder(sessionId, options.webContents);
        let releaseGate: (() => void) | undefined;
        let resolvedModel: ResolvedModel | undefined;
        let unsubscribeApproval: (() => void) | undefined;
        let unsubscribeAsk: (() => void) | undefined;

        // 本轮效果面（机器经 TurnDeps 在正确时机调用；闭包捕获 span/累积器/窗口）
        const deps: TurnDeps = {
          resolveModel: async () => {
            resolvedModel = modelRegistry.resolve(undefined);
            return resolvedModel.modelId;
          },
          acquireGate: async () => {
            // 并发公平调度：无空位时 FIFO 排队；排队期间 abort 走 AbortError 分类
            releaseGate =
              this.concurrencyGate === undefined
                ? undefined
                : await this.concurrencyGate.acquire(sessionId, controller.signal);
          },
          executeTurn: async () => {
            // 非空：resolving 成功后才会进入 running（机器结构保证）
            const resolved = resolvedModel;
            if (resolved === undefined) {
              throw new Error('回合装配状态缺失（结构上不可达的防御分支）');
            }
            // 回合事件仅内部消费：类级监听器（onTurnEvent，供记忆捕获）与
            // TEXT_DELTA 累积（落库）订阅；不再向渲染层 IPC 推送——渲染层
            // 流式渲染走 agent:stream:part，回合历史走 session:getTurns 拉取
            unsubscribeAll = subscribeTurnAccumulators(turnEmitter, {
              onTextDelta: (text) => {
                assistantText += text;
              },
              onToolCall: (entry) => {
                transcriptEntries.push(entry);
              },
            });

            // 用户消息落库（回合开始）：失败静默（见方法注释）
            this.persistUserMessageQuietly(sessionId, turnId, options);

            // 1.5 解析 System Prompt（P2-32：调用方已解析时复用，同回合不二次 resolve；
            //     失败容忍：PromptService 内部已回退硬编码默认值）
            let systemPrompt = options.systemPrompt;
            if (systemPrompt === undefined) {
              const resolvedPrompt = await this.resolveSystemPrompt(options);
              systemPrompt = resolvedPrompt.content;
              logger.debug(
                { sessionId, source: resolvedPrompt.source },
                '已加载默认 Code Agent prompt',
              );
            }

            // 装配 + 消费（38 号：提取至 turn-assembly.ts——模型实例/超时信号/
            // 预算/streamText/TurnRunner/usage；超时与空回复归因在机器 deciding）
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
            const tools = this.toolRegistry.toAISDKTools(
              baseCtx,
              this.buildToolExecuteHook({
                sessionId,
                turnId,
                options,
                turnEmitter,
                transcriptEntries,
              }),
            );
            const output = await assembleAndRunTurn({
              sessionId,
              turnId,
              resolvedModel: resolved,
              options,
              controller,
              turnEmitter,
              transcriptEntries,
              pushPart: (part) => {
                rawPartCount += 1;
                partForwarder.push(part);
              },
              resolveGeneration: (prompt, spanRef) =>
                this.resolveTurnGeneration({
                  sessionId,
                  messages: options.messages,
                  thinking: options.thinking,
                  temperature: options.temperature,
                  resolvedModel: resolved,
                  systemPrompt: prompt,
                  span: spanRef as import('@opentelemetry/api').Span | undefined,
                }),
              systemPrompt,
              tools,
              llmClient: this.llmClient,
              span,
            });
            // 超时/空回复/中断/完成的归因与收尾：由机器 deciding 决策链按序裁决
            // （guards：isTimeout ▶ isEmptyResponse ▶ isAborted ▶ completed，见机器文件头；
            // 超时/空回复的 AppError 亦在机器内构造——本方法不再人工排序）
            return {
              reason: output.reason,
              durationMs: output.durationMs,
              rawPartCount,
              usage: output.usage,
              timeoutSignalAborted: output.timeoutSignalAborted,
            };
          },
          finalizeCompleted: (output) => {
            partForwarder.flush();
            // 非空：completed 必经 executeTurn 成功（机器结构保证）；防御性兜底
            if (resolvedModel === undefined || output === undefined) {
              logger.error({ sessionId }, 'finalizeCompleted 在非完整装配态被调用');
              return;
            }
            const runResult: TurnRunResult = { reason: 'completed', durationMs: output.durationMs };
            this.finalizeCompletedTurn({
              sessionId,
              turnId,
              resolvedModel,
              runResult,
              usage: output.usage as SdkTotalUsageLike | null,
              turnEmitter,
              options,
              assistantText,
              transcriptEntries,
              span,
            });
          },
          finalizeAborted: (output) => {
            logger.info({ sessionId }, 'Agent 对话被用户中断');
            span?.setAttribute('agent.aborted', true);
            partForwarder.flush();
            this.completeTurn({
              sessionId,
              turnId,
              modelId: resolvedModel?.modelId ?? 'unknown',
              reason: 'aborted',
              durationMs: output?.durationMs ?? Date.now() - turnStartTime,
              emitter: turnEmitter,
              ...(options.webContents !== undefined ? { webContents: options.webContents } : {}),
              assistantText,
              transcriptEntries,
            });
          },
          finalizeError: (error) => {
            partForwarder.flush();
            this.finalizeErrorTurn({
              sessionId,
              turnId,
              modelId: resolvedModel?.modelId ?? 'unknown',
              error: error ?? new Error('回合异常终止（错误对象缺失）'),
              turnStartTime,
              turnEmitter,
              options,
              assistantText,
              transcriptEntries,
            });
          },
          flushForwarder: () => {
            partForwarder.flush();
          },
          releaseGate: () => {
            releaseGate?.();
          },
          clearModelTimeout: () => {
            // 显式 no-op：模型级超时定时器现由 turn-assembly 在 try/finally 内
            // 创建与清理（谁创建谁清理），宿主已不再持有该定时器。
            // 保留本 dep 是为不动机器 TurnDeps 契约（running.exit 引用它）——
            // 若要一并清理，需同步改 agent-turn-machine 的 TurnDeps/action/exit
            // 与 exit 顺序测试（跨模块，另行处理）
          },
          cleanup: () => {
            // 订阅退订（防泄漏）→ registry CAS（R2：仅当注册表里仍是自己时才删，
            // abort() 已删 → startAgent 写入新 controller → 旧流收尾不误删新
            // controller）→ 耗时日志 + span 收尾
            unsubscribeAll();
            forwardTurnEvents();
            unsubscribeApproval?.();
            unsubscribeAsk?.();
            this.registry.removeControllerIfCurrent(sessionId, controller);
            const durationMs = Math.round(performance.now() - startTime);
            logger.info({ sessionId, durationMs }, 'Agent streamText 总耗时');
            span?.setAttribute('agent.durationMs', durationMs);
            span?.end();
          },
          expireApproval: (approvalId) => {
            // 38 号阶段 2 收尾：机器 after 超时 → 让 permission-service 以
            // 「超时」语义拒绝 pending（未注入 permissionService 时 no-op——
            // 无审批通道场景本就不会进入 waitingApproval）
            this.permissionService?.expireApproval(approvalId);
          },
          expireAsk: (askId) => {
            // 38 号阶段 2 收尾：机器 after 超时 → agent-ask-service 以「未响应」
            // 语义 resolve(null)（askService 为模块单例，恒可用）
            agentAskService.expireAsk(askId);
          },
        };

        const actor = createAgentTurnActor({ sessionId, turnId, deps });
        // 审批生命周期订阅（waitingApproval 状态运行时数据源；start 前建立）
        unsubscribeApproval = subscribeApprovalLifecycle(this.permissionService, sessionId, actor);
        // 提问生命周期订阅（waitingInput 状态运行时数据源；同审批模式）
        unsubscribeAsk = subscribeAskLifecycle(agentAskService, sessionId, actor);
        // 终态等待：机器进入任一 final 即 done（全部路径结构上必达终态）
        const done = new Promise<void>((resolve) => {
          actor.subscribe((snapshot) => {
            if (snapshot.status === 'done') {
              resolve();
            }
          });
        });
        actor.start();
        await done;
      },
    );
  }

  /**
   * 阶段 4：生成参数与上下文预算解析（2026-09-12 自 streamToWebContents 提取）
   *
   * TokenBudget 回合级调度（对齐 qwen token-budget）：
   * - over-limit：上下文超硬上限 → 抛 AI_CONTEXT_TOO_LARGE（防供应商 400）
   * - warn：接近压缩线 → 日志/遥测提醒（提前几轮缓冲）
   * - compact 及以下：压缩消息历史（截断不计条数）
   *
   * 固定开销（system + 工具定义）计入窗口（2026-09-06 审计修复，见 token-overhead.ts）。
   *
   * @returns 压缩后的消息历史 + 生成选项（思考强度/采样参数/输出上限；
   *          prompt 口径含固定开销，防高估输出）
   * @throws AppError(AI_CONTEXT_TOO_LARGE) 上下文超硬上限
   */
  private resolveTurnGeneration(args: {
    readonly sessionId: string;
    readonly messages: ChatMessage[];
    readonly thinking: StartAgentOptions['thinking'];
    readonly temperature: StartAgentOptions['temperature'];
    readonly resolvedModel: ResolvedModel;
    readonly systemPrompt: string;
    readonly span: import('@opentelemetry/api').Span | undefined;
  }): { readonly compressedMessages: ChatMessage[]; readonly genOptions: GenerationOptions } {
    const { sessionId, messages, thinking, temperature, resolvedModel, systemPrompt, span } = args;
    // 上下文压缩：窗口感知预算（对齐 qwen compaction 阈值体系），默认窗口 128K
    const contextWindowSize = resolvedModel.capabilities.contextWindowSize ?? 128_000;
    const budget = resolveTokenBudgetBasis(contextWindowSize, systemPrompt, this.toolRegistry);
    const contextTokens = estimateMessagesTokens(messages);
    const budgetDecision = getTokenBudgetDecision(contextTokens, budget.effectiveWindow);
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
    const compactionBudget = getCompactionBudget(budget.effectiveWindow);
    const compressedMessages = compressByTokenBudget(messages, compactionBudget);
    if (compressedMessages.length < messages.length) {
      logger.info(
        {
          originalCount: messages.length,
          compressedCount: compressedMessages.length,
        },
        '上下文已压缩',
      );
    }
    // 生成选项：思考强度 / 采样参数 / 输出上限（prompt 口径含固定开销，防高估输出）
    const genOptions = buildGenerationOptions(
      resolvedModel,
      estimateMessagesTokens(compressedMessages) + budget.overheadTokens,
      thinking,
      temperature,
    );
    return { compressedMessages, genOptions };
  }

  /**
   * completed 收尾：由机器 completed 终态 entry 调用（deps.finalizeCompleted）
   *
   * 三件事（顺序即语义）：usage 投影与上报（reportTurnUsage，含 span 打点）→
   * completeTurn(completed) 落库（turn-end 事件 + END 推送 + transcript）→
   * 标题生成（异步、失败静默：会话仍是默认标题时用首条用户消息生成）。
   *
   * @param usage SDK totalUsage（宿主已 await 得到；失败时为 null）
   */
  private finalizeCompletedTurn(args: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly resolvedModel: ResolvedModel;
    readonly runResult: TurnRunResult;
    readonly usage: SdkTotalUsageLike | null | undefined;
    readonly turnEmitter: TurnEventEmitter;
    readonly options: StartAgentOptions;
    readonly assistantText: string;
    readonly transcriptEntries: readonly TurnTranscriptEntry[];
    readonly span: import('@opentelemetry/api').Span | undefined;
  }): void {
    const {
      sessionId,
      turnId,
      resolvedModel,
      runResult,
      usage,
      turnEmitter,
      options,
      assistantText,
      transcriptEntries,
      span,
    } = args;
    const turnUsage = projectTurnUsage(usage);
    reportTurnUsage(
      {
        recordUsage: (input) => this.sessionService.recordUsage(input),
        ...(span !== undefined ? { span } : {}),
      },
      { sessionId, modelId: resolvedModel.modelId, usage },
    );

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
      transcriptEntries,
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

  /**
   * error 收尾：由机器 error 终态 entry 调用（deps.finalizeError）
   *
   * 非 AbortError 的异常出口（AbortError 走 aborted——用户中断不是错误，机器
   * isAbortFailure guard 已路由）。四件事：classifyError 归类 → 推送
   * AGENT_STREAM_ERROR（webContents 存活时）→ 回合事件 ERROR →
   * completeTurn(error) 落库。**状态收敛已由机器完成**，本方法不回发状态事件。
   */
  private finalizeErrorTurn(args: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly modelId: string;
    readonly error: unknown;
    readonly turnStartTime: number;
    readonly turnEmitter: TurnEventEmitter;
    readonly options: StartAgentOptions;
    readonly assistantText: string;
    readonly transcriptEntries: readonly TurnTranscriptEntry[];
  }): void {
    const {
      sessionId,
      turnId,
      modelId,
      error,
      turnStartTime,
      turnEmitter,
      options,
      assistantText,
      transcriptEntries,
    } = args;
    const appError = classifyError(error);
    if (options.webContents !== undefined && !options.webContents.isDestroyed()) {
      const errorPayload: AgentStreamErrorPayload = {
        sessionId,
        code: appError.code,
        message: appError.message,
      };
      emitEvent(options.webContents, IPC_DEFINITIONS.agent.subscribeStreamError, errorPayload);
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
      modelId,
      reason: 'error',
      durationMs: Date.now() - turnStartTime,
      emitter: turnEmitter,
      ...(options.webContents !== undefined ? { webContents: options.webContents } : {}),
      assistantText,
      transcriptEntries,
    });
    logger.error({ sessionId, errorCode: appError.code, error: appError }, 'Agent 对话流异常结束');
  }

  /**
   * 持久化回合流水（失败不阻断主流程）
   *
   * 由 completeTurn 以 fire-and-forget 调用（`void this.persistTurn(...)`）——
   * 落库失败只记日志，不影响回合已推送给渲染层的终态。
   *
   * seq 由 usage-turn-store.recordTurn 内部用 `MAX(seq)+1` 原子计算
   * （2026-09-08 修复：此前这里全量查 turns 取 length，既 O(n²) 又在
   * 并发写同一会话时产生重复 seq）。此处传 0 占位，实际值以存储层为准。
   */
  private async persistTurn(turn: TurnEndEvent, modelId: string): Promise<void> {
    try {
      await this.sessionService.recordTurn({
        turnId: turn.turnId,
        sessionId: turn.sessionId,
        seq: 0,
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
   * 统一回合收尾：turn-end 事件 + 失效域广播 + AGENT_STREAM_END 推送 + 落库
   *
   * 三个出口（completed / aborted / error）共用，消除重复。由三个 finalize
   * 方法各自调用（completed → finalizeCompletedTurn；aborted → deps.finalizeAborted；
   * error → finalizeErrorTurn）。
   *
   * 顺序约束：失效域广播**先于** END 推送（同窗口队列保序，渲染层先登记
   * 「回合结束域已覆盖」，stream:end 处理据此跳过旧清单——渐进回落）。
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
    /** 回合转录条目（reasoning/tool-call/tool-result，见 turn-transcript.ts） */
    readonly transcriptEntries?: readonly TurnTranscriptEntry[];
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

    // 失效域聚合声明（31 号 spec S7）：迁移自渲染层 use-agent-bridge 的硬编码清单
    // （sessions/session:<id>/goal/task/usage/git/file/turns）。三出口（completed/
    // aborted/error）共用；不判 webContents——无头回合（IM/远程/定时触发）此前无
    // stream:end 推送 ⇒ 渲染层缓存永久 stale，现在统一广播。
    // 先于 AGENT_STREAM_END 推送：同窗口队列保序，渲染层先登记「回合结束域已覆盖」，
    // stream:end 处理据此跳过旧清单（渐进回落，见 use-agent-bridge 注释）。
    broadcastInvalidation(turnEndInvalidationDomains(params.sessionId), params.sessionId);

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

    // 助手消息落库（含富 parts：reasoning/tool-call/tool-result——重开会话可见；
    // 中断/错误回合保留已发生的部分——历史不因失败丢失；
    // try/catch 兜底测试桩返回非 Promise 等同步异常）
    const turnMessages = buildAssistantTurnMessages(
      params.assistantText ?? '',
      params.transcriptEntries ?? [],
    );
    if (turnMessages.length > 0) {
      try {
        void this.sessionService
          .appendMessage({
            sessionId: params.sessionId,
            turnId: params.turnId,
            messages: turnMessages,
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
