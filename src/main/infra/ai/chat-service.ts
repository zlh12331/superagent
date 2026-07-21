// src/main/infra/ai/chat-service.ts
// 聊天服务：封装 Vercel AI SDK v7 streamText + UIMessageStream → IPC 推送
// 替换原 StreamBridge 的职责：session 管理 + abort + 错误分类 + IPC 桥接
//
// 职责：
// 1. 接收渲染层发起的 chat:send 请求，启动 streamText 流式响应
// 2. 把 result.toUIMessageStream() 的 part 逐个通过 IPC 推送到渲染层
// 3. 维护 sessionId → AbortController Map，支持中断指定/全部对话
// 4. 错误分类（限流/超时/网络/API key 失效）→ AppError → CHAT_STREAM_ERROR 推送
// 5. webContents.isDestroyed 守卫，避免销毁后继续推送
//
// 设计文档 §4.3 ai/chat-service（已适配 Vercel AI SDK v7）
//
// 接口化（P0-2 改造）：
// - 抽出 IChatService 接口，ChatService 类实现该接口
// - ServiceContainer 持有 IChatService 实例并注入到 IPC handler
// - 便于测试 mock 与未来支持本地 LLM 等可替换实现

import { randomUUID } from 'node:crypto';
import type {
  ChatMessage,
  ChatStreamEndPayload,
  ChatStreamErrorPayload,
  ChatStreamPartPayload,
} from '@novel-writer/shared';
import { AppError, ErrorCode, IPC_CHANNELS } from '@novel-writer/shared';
import { type ModelMessage, streamText } from 'ai';
import type { WebContents } from 'electron';
import { logger } from '../../utils/logger';
import { getModel } from './ai-provider';

/**
 * 对话启动选项
 */
export interface StartChatOptions {
  /** 完整消息历史（最后一条通常是 user 新消息） */
  readonly messages: ChatMessage[];
  /**
   * 可选 sessionId：续传已有对话时传入；省略则生成新 id
   *
   * 使用 `string | undefined` 而非 `?: string`：
   * exactOptionalPropertyTypes 严格模式下，调用方传 `{ sessionId: undefined }` 时
   * 显式声明 `| undefined` 才能接受 zod 推断的 `string | undefined` 类型。
   */
  readonly sessionId: string | undefined;
  /** 接收流式 part 的 webContents（通常是发起 chat:send 的窗口） */
  readonly webContents: WebContents;
}

/**
 * ChatService 接口（P0-2 抽出）
 *
 * 解耦 IPC handler 对具体类的依赖，便于：
 * - 单元测试：注入 mock 实现，不依赖真实 streamText
 * - 未来扩展：替换为本地 LLM、多 provider 路由等实现
 */
export interface IChatService {
  /** 启动一次对话，返回 sessionId（渲染层用此 id 订阅后续流式事件） */
  startChat(options: StartChatOptions): Promise<string>;
  /** 中断指定 sessionId 的对话，返回是否成功中断 */
  abort(sessionId: string): boolean;
  /** 中断所有活跃对话（用于应用退出 / 窗口关闭场景） */
  abortAll(): void;
}

/**
 * ChatService 默认实现
 *
 * 管理 sessionId → AbortController 映射，提供启动/中断对话的能力。
 *
 * 设计：
 * - 单例模式：通过 getChatService() 获取，整个应用生命周期共享一个实例
 * - 内部 Map 维护活跃对话，对话结束（正常/异常/abort）后从 Map 移除
 * - 所有 IPC 推送都通过 webContents.send，渲染层通过 ipcRenderer.on 订阅
 */
class ChatService implements IChatService {
  /** 活跃对话 Map：sessionId → AbortController */
  private readonly activeSessions = new Map<string, AbortController>();

  /**
   * 启动一次对话
   *
   * 流程：
   * 1. 生成或复用 sessionId
   * 2. 创建 AbortController 并加入 Map
   * 3. 调用 streamText 启动流式响应
   * 4. 异步读取 toUIMessageStream 的 reader，逐 part 通过 IPC 推送
   * 5. 流结束（正常/异常/abort）后从 Map 移除
   *
   * @returns 本次对话的 sessionId（渲染层用此 id 订阅后续流式事件）
   */
  async startChat(options: StartChatOptions): Promise<string> {
    const sessionId = options.sessionId ?? randomUUID();
    const controller = new AbortController();
    this.activeSessions.set(sessionId, controller);

    // 异步推送流式 part（不 await，让 startChat 立即返回 sessionId）
    // 任何错误都通过 catch 推送 CHAT_STREAM_ERROR，不抛回调用方
    void this.streamToWebContents(
      sessionId,
      options.messages,
      options.webContents,
      controller,
    ).catch((err: unknown) => {
      logger.error({ sessionId, error: err }, 'ChatService 流推送异常');
    });

    return sessionId;
  }

  /**
   * 中断指定 sessionId 的对话
   *
   * @returns 是否成功中断（对话已结束则返回 false）
   */
  abort(sessionId: string): boolean {
    const controller = this.activeSessions.get(sessionId);
    if (controller === undefined) {
      return false;
    }
    controller.abort();
    // 不立即从 Map 移除，让流推送协程感知 abort 后自行清理
    return true;
  }

  /**
   * 中断所有活跃对话
   *
   * 用于应用退出 / 窗口关闭场景，避免 streamText 在 webContents 销毁后继续推送。
   */
  abortAll(): void {
    for (const controller of this.activeSessions.values()) {
      controller.abort();
    }
  }

  /**
   * 流式推送实现：读取 toUIMessageStream 的 reader，逐 part 推送到 webContents
   *
   * 内部协程，由 startChat 异步调用，不抛错（错误通过 CHAT_STREAM_ERROR 推送）。
   *
   * 错误处理：
   * - AbortError：用户主动中断，不推送 error（视为正常结束）
   * - API key 缺失/失效：AI_API_KEY_MISSING / AI_API_KEY_INVALID
   * - 网络错误：AI_TIMEOUT / AI_STREAM_INTERRUPTED
   * - 模型错误：AI_MODEL_ERROR
   * - 其他：INTERNAL_ERROR
   */
  private async streamToWebContents(
    sessionId: string,
    messages: ChatMessage[],
    webContents: WebContents,
    controller: AbortController,
  ): Promise<void> {
    try {
      // 1. 获取 model 实例
      const model = await getModel(undefined);

      // 2. 启动 streamText（同步调用，立即返回 result 对象）
      const result = streamText({
        model,
        // 把 ChatMessage 转换为 ModelMessage（结构兼容：role + content: string）
        // AI SDK v7 默认拒绝 messages 中的 system 消息，这里显式允许以兼容旧消息历史
        messages: messages as ModelMessage[],
        allowSystemInMessages: true,
        abortSignal: controller.signal,
      });

      // 3. 把 result 转换为 UIMessageStream（包含 text/tool-call/finish 等 part）
      const uiStream = result.toUIMessageStream();
      const reader = uiStream.getReader();

      // 4. 逐 part 推送到渲染层
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        // webContents 销毁后停止推送（窗口已关闭）
        if (webContents.isDestroyed()) {
          logger.warn({ sessionId }, 'webContents 已销毁，停止推送流');
          break;
        }
        const payload: ChatStreamPartPayload = { sessionId, part: value };
        webContents.send(IPC_CHANNELS.CHAT_STREAM_PART, payload);
      }

      // 5. 正常结束推送 CHAT_STREAM_END
      if (!webContents.isDestroyed()) {
        const endPayload: ChatStreamEndPayload = { sessionId };
        webContents.send(IPC_CHANNELS.CHAT_STREAM_END, endPayload);
      }
    } catch (error: unknown) {
      // AbortError 是用户主动中断，不视为错误（不推送 error）
      if (isAbortError(error)) {
        logger.info({ sessionId }, '对话被用户中断');
        // 中断也推送 END（让渲染层关闭 loading 状态）
        if (!webContents.isDestroyed()) {
          const endPayload: ChatStreamEndPayload = { sessionId };
          webContents.send(IPC_CHANNELS.CHAT_STREAM_END, endPayload);
        }
      } else {
        // 其他错误：分类并推送 CHAT_STREAM_ERROR
        const appError = classifyError(error);
        if (!webContents.isDestroyed()) {
          const errorPayload: ChatStreamErrorPayload = {
            sessionId,
            code: appError.code,
            message: appError.message,
          };
          webContents.send(IPC_CHANNELS.CHAT_STREAM_ERROR, errorPayload);
        }
        logger.error({ sessionId, error: appError }, '对话流异常结束');
      }
    } finally {
      // 无论正常/异常/abort，都从 Map 移除
      this.activeSessions.delete(sessionId);
    }
  }
}

/** ChatService 单例（内部按具体实现类持有，外部暴露为 IChatService 接口） */
let chatService: ChatService | null = null;

/**
 * 获取 ChatService 单例
 *
 * 整个应用生命周期共享一个实例，内部 Map 管理活跃对话。
 *
 * 返回类型为 IChatService 接口而非具体类：
 * - 强制调用方面向接口编程，不依赖 ChatService 内部细节
 * - ServiceContainer 注入到 IPC handler 时类型一致
 */
export function getChatService(): IChatService {
  if (chatService === null) {
    chatService = new ChatService();
  }
  return chatService;
}

/**
 * 重置 ChatService（仅测试用）
 *
 * 调用 abortAll 中断所有活跃对话，并清空单例缓存。
 */
export function resetChatService(): void {
  if (chatService !== null) {
    chatService.abortAll();
    chatService = null;
  }
}

/**
 * 判断是否为 AbortError
 *
 * 不同运行时 AbortError 的 name 可能不同：
 * - 浏览器/Electron：AbortError
 * - Node.js fetch：AbortError
 * - 自定义 controller.abort() 触发的：AbortError
 */
function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError';
  }
  return false;
}

/**
 * 错误分类：把未知错误转换为 AppError
 *
 * AI SDK 抛出的错误通常是 APICallerError / APICallError / AbortError，
 * 这里按错误特征映射到项目的 ErrorCode。
 */
function classifyError(error: unknown): AppError {
  // 已是 AppError：直接返回
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    // API key 相关
    if (message.includes('api key') && message.includes('invalid')) {
      return new AppError(ErrorCode.AI_API_KEY_INVALID, 'API Key 无效', error);
    }
    if (message.includes('unauthorized') || message.includes('401')) {
      return new AppError(ErrorCode.AI_API_KEY_INVALID, 'API Key 无效或已过期', error);
    }

    // 限流
    if (
      message.includes('rate limit') ||
      message.includes('429') ||
      message.includes('too many requests')
    ) {
      return new AppError(ErrorCode.AI_RATE_LIMITED, 'AI 调用过于频繁', error);
    }

    // 超时
    if (message.includes('timeout') || message.includes('timed out')) {
      return new AppError(ErrorCode.AI_TIMEOUT, 'AI 调用超时', error);
    }

    // 上下文过长
    if (
      message.includes('context length') ||
      message.includes('too long') ||
      message.includes('context_length_exceeded')
    ) {
      return new AppError(ErrorCode.AI_CONTEXT_TOO_LARGE, '上下文过长', error);
    }

    // 网络错误（连接失败、中断）
    if (
      message.includes('network') ||
      message.includes('econnreset') ||
      message.includes('fetch failed')
    ) {
      return new AppError(ErrorCode.AI_STREAM_INTERRUPTED, '网络连接中断', error);
    }

    // 模型错误（500 等）
    if (
      message.includes('model') ||
      message.includes('500') ||
      message.includes('502') ||
      message.includes('503')
    ) {
      return new AppError(ErrorCode.AI_MODEL_ERROR, 'AI 模型服务异常', error);
    }
  }

  // 兜底：未知错误
  return new AppError(ErrorCode.INTERNAL_ERROR, 'AI 调用失败', error);
}
