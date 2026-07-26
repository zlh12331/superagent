// src/main/infra/ai/agent-service.ts
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
// 与 ChatService 的区别：
// - ChatService：单轮流式响应（streamText 不带 tools），用于纯对话
// - AgentService：多轮工具调用（streamText 带 tools + stopWhen），用于 Code Agent
// - 二者复用相同的错误分类逻辑（error-classifier.ts）与流推送模式
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
} from '@novel-writer/shared';
import { IPC_CHANNELS } from '@novel-writer/shared';
import { isStepCount, streamText } from 'ai';
import type { WebContents } from 'electron';
import { withSpan } from '../../telemetry/otel';
import { logger } from '../../utils/logger';
import { getModel } from '../ai/ai-provider';
import { classifyError, isAbortError } from '../ai/error-classifier';
import { compressContext } from './context-compression';
import type { IPromptService } from './prompt/prompt-service';
import type { IToolExecutor } from './tool-executor';
import type { IToolRegistry } from './tool-registry';

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
  /** 接收流式 part 的 webContents（通常是发起 agent:run 的窗口） */
  readonly webContents: WebContents;
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
   * 优雅关闭：中断所有活跃 agent 对话并等待 stream 真正完成
   *
   * 与 IChatService.dispose 一致，用于应用退出场景。
   * - abortAll 仅同步触发 abort 信号，streamText 协程仍可能在 reader.read() 等待
   * - dispose 在 abortAll 后等待所有活跃 stream 真正进入 finally 块，带超时兜底
   *
   * @param timeoutMs 超时毫秒数（默认 3000ms）
   */
  dispose(timeoutMs?: number): Promise<void>;
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
  ) {}

  /** 活跃对话 Map：sessionId → AbortController */
  private readonly activeSessions = new Map<string, AbortController>();
  /** 活跃 stream Promise Map：sessionId → streamToWebContents 的 Promise（用于 dispose 等待） */
  private readonly activeStreams = new Map<string, Promise<void>>();

  /** @inheritDoc */
  async startAgent(options: StartAgentOptions): Promise<string> {
    const sessionId = options.sessionId ?? randomUUID();

    // 防重检查：若同 sessionId 已有活跃 stream，先 abort 并等待其退出，避免孤儿 stream
    // 触发场景：用户快速双击发送、stop 后立即 send、跨入口并发 IPC
    const existingController = this.activeSessions.get(sessionId);
    if (existingController !== undefined) {
      logger.warn({ sessionId }, '检测到已有活跃 agent stream，先中断旧 stream');
      existingController.abort();
      const existingStream = this.activeStreams.get(sessionId);
      if (existingStream !== undefined) {
        // 等待旧 stream 真正退出（最多 5s 兜底，避免卡死调用方）
        await Promise.race([
          existingStream,
          new Promise<void>((resolve) => setTimeout(resolve, 5000)),
        ]);
      }
    }

    const controller = new AbortController();
    this.activeSessions.set(sessionId, controller);

    // 异步推送流式 part（不 await，让 startAgent 立即返回 sessionId）
    // 任何错误都通过 catch 推送 AGENT_STREAM_ERROR，不抛回调用方
    // catch 内部仅记录日志，不改变 Promise 状态（仍为 fulfilled），
    // 这样 dispose 的 Promise.allSettled 不会被 reject 影响
    const streamPromise = this.streamToWebContents(sessionId, options, controller).catch(
      (err: unknown) => {
        logger.error({ sessionId, error: err }, 'AgentService 流推送异常');
      },
    );
    this.activeStreams.set(sessionId, streamPromise);

    // CAS 删除 activeStreams：streamPromise resolve 后检查 Map 是否还是自己
    // 避免旧 stream 的清理逻辑误删新 stream 的 Promise（与 activeSessions 的 CAS 删除同理）
    streamPromise.finally(() => {
      if (this.activeStreams.get(sessionId) === streamPromise) {
        this.activeStreams.delete(sessionId);
      }
    });

    return sessionId;
  }

  /** @inheritDoc */
  abort(sessionId: string): boolean {
    const controller = this.activeSessions.get(sessionId);
    if (controller === undefined) {
      return false;
    }
    // 立即从 Map 删除 controller，避免以下竞态：
    //   T0: abort(sessionId) → controller.abort()
    //   T1: startAgent(sessionId) → activeSessions.set(sessionId, newController)  // 覆盖
    //   T2: 旧 stream 的 finally → activeSessions.delete(sessionId)  // ❌ 误删新 controller
    // 改为立即删除：旧 stream 的 finally 改为 CAS 检查（见 streamToWebContents finally）
    this.activeSessions.delete(sessionId);
    controller.abort();
    return true;
  }

  /** @inheritDoc */
  abortAll(): void {
    for (const controller of this.activeSessions.values()) {
      controller.abort();
    }
  }

  /** @inheritDoc */
  async dispose(timeoutMs = 3000): Promise<void> {
    // 1. 触发所有 abort 信号
    this.abortAll();

    // 2. 收集所有活跃 stream Promise
    const streams = Array.from(this.activeStreams.values());
    if (streams.length === 0) {
      return;
    }

    // 3. 等待所有 stream 完成，或超时
    //    allSettled 而非 all：即使某个 stream 抛错也等待其他完成
    //    （streamToWebContents 内部已 catch 所有错误，这里双保险）
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutId = setTimeout(() => {
        logger.warn(
          { streamCount: streams.length, timeoutMs },
          'AgentService dispose 超时，强制清空',
        );
        resolve();
      }, timeoutMs);
    });

    try {
      await Promise.race([Promise.allSettled(streams), timeoutPromise]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }

    // 4. 清空 Map（即使超时也清空，避免内存泄漏）
    this.activeSessions.clear();
    this.activeStreams.clear();
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
        try {
          // 1. 获取 model 实例（与 ChatService 一致，复用 ai-provider 单例）
          const model = await getModel(undefined);

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
          const baseCtx = {
            workingDir: options.workingDir,
            sessionId,
            abortSignal: controller.signal,
            webContents: options.webContents,
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
            const result = await this.toolExecutor.execute(
              tool.name,
              ctx.callId,
              input,
              ctx,
              options.webContents,
            );
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
          const compressedMessages = compressContext(options.messages);
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

          const result = streamText({
            model,
            messages: compressedMessages,
            allowSystemInMessages: true,
            ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
            tools,
            // AI SDK v7 用 stopWhen 替代 maxSteps
            stopWhen: isStepCount(options.maxSteps),
            abortSignal: controller.signal,
          });

          // 5. 把 result 转换为 UIMessageStream（包含 text/tool-call/tool-result/finish 等 part）
          const uiStream = result.toUIMessageStream();
          const reader = uiStream.getReader();

          // 6. 逐 part 推送到渲染层
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            // webContents 销毁后停止推送（窗口已关闭）
            if (options.webContents.isDestroyed()) {
              logger.warn({ sessionId }, 'webContents 已销毁，停止推送 agent 流');
              break;
            }
            const payload: AgentStreamPartPayload = { sessionId, part: value };
            options.webContents.send(IPC_CHANNELS.AGENT_STREAM_PART, payload);
          }

          // 7. 正常结束推送 AGENT_STREAM_END（reason='completed'）
          if (!options.webContents.isDestroyed()) {
            const endPayload: AgentStreamEndPayload = {
              sessionId,
              reason: 'completed',
            };
            options.webContents.send(IPC_CHANNELS.AGENT_STREAM_END, endPayload);
          }

          // 8. token 使用量统计（AI SDK v7 原生支持，免费数据）
          //    totalUsage 是 PromiseLike（流结束后才 resolve），不 await 避免阻塞清理
          //    失败时静默：不阻塞主流程
          //    用 Promise.resolve 包裹以获得 .catch 方法（PromiseLike 本身无 .catch）
          Promise.resolve(result.totalUsage)
            .then((usage) => {
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
            })
            .catch(() => {
              // usage 读取失败，忽略
            });
        } catch (error: unknown) {
          // AbortError 是用户主动中断，不视为错误（推送 reason='aborted' 的 END）
          if (isAbortError(error)) {
            logger.info({ sessionId }, 'Agent 对话被用户中断');
            span?.setAttribute('agent.aborted', true);
            if (!options.webContents.isDestroyed()) {
              const endPayload: AgentStreamEndPayload = {
                sessionId,
                reason: 'aborted',
              };
              options.webContents.send(IPC_CHANNELS.AGENT_STREAM_END, endPayload);
            }
          } else {
            // 其他错误：分类并推送 AGENT_STREAM_ERROR
            const appError = classifyError(error);
            if (!options.webContents.isDestroyed()) {
              const errorPayload: AgentStreamErrorPayload = {
                sessionId,
                code: appError.code,
                message: appError.message,
              };
              options.webContents.send(IPC_CHANNELS.AGENT_STREAM_ERROR, errorPayload);
            }
            logger.error(
              { sessionId, errorCode: appError.code, error: appError },
              'Agent 对话流异常结束',
            );
          }
        } finally {
          // CAS（Compare-And-Swap）删除 activeSessions：
          // 仅当 Map 里存的还是自己时才删，避免以下竞态：
          //   abort() 已从 Map 删除 → startAgent 写入新 controller → 旧 stream finally 误删新 controller
          // 通过 controller 引用比较保证只删除自己的条目
          // activeStreams 的 CAS 删除在 startAgent 的 .finally() 链中处理（streamPromise 是 startAgent 局部变量）
          if (this.activeSessions.get(sessionId) === controller) {
            this.activeSessions.delete(sessionId);
          }

          // 性能埋点：总耗时（从 streamText 开始到流推送完毕）
          const durationMs = Math.round(performance.now() - startTime);
          logger.info({ sessionId, durationMs }, 'Agent streamText 总耗时');
          span?.setAttribute('agent.durationMs', durationMs);
          span?.end();
        }
      },
    );
  }
}
