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
import { logger } from '../../utils/logger';
import { getModel } from '../ai/ai-provider';
import { classifyError, isAbortError } from '../ai/error-classifier';
import type { ToolContext } from './tool';
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
 *
 * 单例模式：通过 ServiceContainer 持有，整个应用生命周期共享一个实例。
 * 内部维护 sessionId → AbortController + streamPromise 两个 Map（与 ChatService 一致）。
 */
export class AgentService implements IAgentService {
  /**
   * @param toolRegistry 工具注册表（用于 toAISDKTools）
   * @param toolExecutor 工具执行器（作为 executeHook 注入到 AI SDK tool.execute）
   */
  constructor(
    private readonly toolRegistry: IToolRegistry,
    private readonly toolExecutor: IToolExecutor,
  ) {}

  /** 活跃对话 Map：sessionId → AbortController */
  private readonly activeSessions = new Map<string, AbortController>();
  /** 活跃 stream Promise Map：sessionId → streamToWebContents 的 Promise（用于 dispose 等待） */
  private readonly activeStreams = new Map<string, Promise<void>>();

  /** @inheritDoc */
  async startAgent(options: StartAgentOptions): Promise<string> {
    const sessionId = options.sessionId ?? randomUUID();
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

    return sessionId;
  }

  /** @inheritDoc */
  abort(sessionId: string): boolean {
    const controller = this.activeSessions.get(sessionId);
    if (controller === undefined) {
      return false;
    }
    controller.abort();
    // 不立即从 Map 移除，让流推送协程感知 abort 后自行清理
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
    try {
      // 1. 获取 model 实例（与 ChatService 一致，复用 ai-provider 单例）
      const model = await getModel(undefined);

      // 2. 构造 ToolContext（每次对话独立，闭包捕获 sessionId / workingDir / abortSignal）
      //    所有工具调用共享同一个 ctx，ToolExecutor 据此关联 IPC 事件
      const ctx: ToolContext = {
        workingDir: options.workingDir,
        sessionId,
        abortSignal: controller.signal,
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
      const tools = this.toolRegistry.toAISDKTools(ctx, async (tool, input, ctx, toolCallId) => {
        const result = await this.toolExecutor.execute(
          tool.name,
          toolCallId,
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
      const result = streamText({
        model,
        // ChatMessage = ModelMessage（type-only import），可直接透传
        messages: options.messages,
        // AI SDK v7 默认拒绝 messages 中的 system 消息，这里显式允许以兼容旧消息历史
        allowSystemInMessages: true,
        // 条件展开：systemPrompt 为 undefined 时不传 system 字段
        ...(options.systemPrompt !== undefined ? { system: options.systemPrompt } : {}),
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
    } catch (error: unknown) {
      // AbortError 是用户主动中断，不视为错误（推送 reason='aborted' 的 END）
      if (isAbortError(error)) {
        logger.info({ sessionId }, 'Agent 对话被用户中断');
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
        logger.error({ sessionId, error: appError }, 'Agent 对话流异常结束');
      }
    } finally {
      // 无论正常/异常/abort，都从两个 Map 同步移除
      // dispose 通过 Promise.allSettled 等待 streamPromise resolve
      this.activeSessions.delete(sessionId);
      this.activeStreams.delete(sessionId);
    }
  }
}
