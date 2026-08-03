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
} from '@code-agent/shared/main';
import { IPC_CHANNELS } from '@code-agent/shared/main';
import { streamText } from 'ai';
import type { WebContents } from 'electron';
import { logger } from '../../utils/logger';
import { getModel } from './ai-provider';
import { classifyError, isAbortError } from './error-classifier';

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
 *
 * P3-10 改造：新增 dispose(timeoutMs?) 异步收尾方法
 * - abortAll() 仅同步触发 AbortController.abort()，streamText 协程仍可能在 reader.read() 等待
 * - dispose() 在 abortAll 后等待所有活跃 stream 真正进入 finally 块，避免：
 *   · 进程退出时正在进行的 IPC send 丢失
 *   · streamText 协程未感知 abort 导致资源泄漏
 *   · 渲染层未收到 CHAT_STREAM_END/ERROR 导致 loading 状态卡死
 */
export interface IChatService {
  /** 启动一次对话，返回 sessionId（渲染层用此 id 订阅后续流式事件） */
  startChat(options: StartChatOptions): Promise<string>;
  /** 中断指定 sessionId 的对话，返回是否成功中断 */
  abort(sessionId: string): boolean;
  /** 中断所有活跃对话（用于应用退出 / 窗口关闭场景） */
  abortAll(): void;
  /**
   * 优雅关闭：中断所有活跃对话并等待 stream 真正完成（P3-10）
   *
   * 用于应用退出场景，与 abortAll 的区别：
   * - abortAll：仅同步触发 abort 信号，不等待流协程响应
   * - dispose：触发 abort + 等待所有活跃 stream 进入 finally 块，带超时兜底
   *
   * @param timeoutMs 超时毫秒数（默认 3000ms），避免 hang 死阻塞退出
   */
  dispose(timeoutMs?: number): Promise<void>;
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
   * 活跃 stream Promise Map：sessionId → streamToWebContents 的 Promise
   *
   * P3-10 新增：用于 dispose 时等待所有 stream 真正完成（进入 finally 块）。
   * 与 activeSessions 配对维护：
   * - startChat 时同时写入两个 Map
   * - streamToWebContents 的 finally 同时清空两个 Map
   * - dispose 时 await 所有 Promise，确保流协程已响应 abort 并完成清理
   */
  private readonly activeStreams = new Map<string, Promise<void>>();

  /**
   * 启动一次对话
   *
   * 流程：
   * 1. 生成或复用 sessionId
   * 2. 防重检查：若 sessionId 已有活跃 stream，先 abort 旧 stream 并等待其退出（对齐 AgentService）
   * 3. 创建 AbortController 并加入 Map
   * 4. 调用 streamText 启动流式响应
   * 5. 异步读取 toUIMessageStream 的 reader，逐 part 通过 IPC 推送
   * 6. 流结束（正常/异常/abort）后从 Map 移除
   *
   * @returns 本次对话的 sessionId（渲染层用此 id 订阅后续流式事件）
   */
  async startChat(options: StartChatOptions): Promise<string> {
    const sessionId = options.sessionId ?? randomUUID();

    // 防重检查：若 sessionId 已有活跃 stream，先中断旧 stream 并等待其退出
    // 避免覆盖旧 controller 导致旧 stream 无法被 abort（孤儿 stream 内存泄漏）
    // 对齐 AgentService.startAgent 的实现
    const existingController = this.activeSessions.get(sessionId);
    if (existingController !== undefined) {
      logger.warn({ sessionId }, '检测到已有活跃 chat stream，先中断旧 stream');
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

    // 异步推送流式 part（不 await，让 startChat 立即返回 sessionId）
    // 任何错误都通过 catch 推送 CHAT_STREAM_ERROR，不抛回调用方
    //
    // P3-10：把 streamPromise 存入 activeStreams，dispose 时等待其完成
    // catch 内部仅记录日志，不改变 Promise 状态（仍为 fulfilled），
    // 这样 dispose 的 Promise.allSettled 不会被 reject 影响
    const streamPromise = this.streamToWebContents(
      sessionId,
      options.messages,
      options.webContents,
      controller,
    ).catch((err: unknown) => {
      logger.error({ sessionId, error: err }, 'ChatService 流推送异常');
    });
    this.activeStreams.set(sessionId, streamPromise);

    return sessionId;
  }

  /**
   * 中断指定 sessionId 的对话
   *
   * 立即从 Map 删除 controller，避免以下竞态（对齐 AgentService.abort）：
   *   T0: abort(sessionId) → controller.abort()
   *   T1: startChat(sessionId) → activeSessions.set(sessionId, newController)  // 覆盖
   *   T2: 旧 stream 的 finally → activeSessions.delete(sessionId)  // ❌ 误删新 controller
   * 改为立即删除：旧 stream 的 finally 改为 CAS 检查（见 streamToWebContents finally）
   *
   * @returns 是否成功中断（对话已结束则返回 false）
   */
  abort(sessionId: string): boolean {
    const controller = this.activeSessions.get(sessionId);
    if (controller === undefined) {
      return false;
    }
    // 立即从 Map 删除 controller，配合 finally 的 CAS 检查避免误删新 controller
    this.activeSessions.delete(sessionId);
    controller.abort();
    return true;
  }

  /**
   * 中断所有活跃对话
   *
   * 用于应用退出 / 窗口关闭场景，避免 streamText 在 webContents 销毁后继续推送。
   *
   * 注意：本方法仅同步触发 abort 信号，不等待流协程响应。
   * 如需等待流真正完成，应使用 dispose()（P3-10）。
   */
  abortAll(): void {
    for (const controller of this.activeSessions.values()) {
      controller.abort();
    }
  }

  /**
   * 优雅关闭：中断所有活跃对话并等待 stream 真正完成（P3-10）
   *
   * 与 abortAll 的区别：
   * - abortAll：仅同步触发 abort 信号，streamText 协程仍可能在 reader.read() 等待
   * - dispose：触发 abort + 等待所有活跃 stream 进入 finally 块
   *
   * 使用场景：应用退出（before-quit 事件），避免：
   * - 进程退出时正在进行的 IPC send 丢失
   * - streamText 协程未感知 abort 导致资源泄漏
   * - 渲染层未收到 CHAT_STREAM_END/ERROR 导致 loading 状态卡死
   *
   * 超时兜底：若 streamText 协程在 timeoutMs 内未完成（异常情况），
   * 强制清空 Map 让进程退出，避免 hang 死阻塞用户关机。
   *
   * @param timeoutMs 超时毫秒数，默认 3000ms
   */
  async dispose(timeoutMs = 3000): Promise<void> {
    // 1. 触发所有 abort 信号
    this.abortAll();

    // 2. 收集所有活跃 stream Promise
    const streams = Array.from(this.activeStreams.values());
    if (streams.length === 0) {
      // 无活跃对话，直接返回
      return;
    }

    // 3. 等待所有 stream 完成，或超时
    //    使用 Promise.race 实现：哪个先完成都行
    //    allSettled 而非 all：即使某个 stream 抛错也等待其他完成
    //    （streamToWebContents 内部已 catch 所有错误，这里双保险）
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutId = setTimeout(() => {
        logger.warn(
          { streamCount: streams.length, timeoutMs },
          'ChatService dispose 超时，强制清空',
        );
        resolve();
      }, timeoutMs);
    });

    try {
      await Promise.race([Promise.allSettled(streams), timeoutPromise]);
    } finally {
      // 清理 timeout（若 allSettled 先完成，取消超时任务）
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }

    // 4. 清空 Map（即使超时也清空，避免内存泄漏）
    //    注意：streamToWebContents 的 finally 也会 delete，但 dispose 可能在超时后调用，
    //    此时 stream 协程仍在运行，强制清空避免后续 startChat 复用同一 sessionId 时冲突
    this.activeSessions.clear();
    this.activeStreams.clear();
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
    // 性能埋点：从 streamText 开始到流推送完毕的总耗时
    const startTime = performance.now();
    try {
      // 1. 获取 model 实例
      const model = await getModel(undefined);

      // 2. 启动 streamText（同步调用，立即返回 result 对象）
      const result = streamText({
        model,
        // P1-6 透传设计：ChatMessage = ModelMessage（type-only import）
        // 渲染层已用 convertToModelMessages 转换好，主进程直接透传即可
        // AI SDK v7 默认拒绝 messages 中的 system 消息，这里显式允许以兼容旧消息历史
        messages,
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
        // 主动 cancel reader + abort controller，让 streamText 协程感知并释放底层资源
        // （HTTP 连接、内部 ReadableStream 等），避免孤儿 stream 内存泄漏
        if (webContents.isDestroyed()) {
          logger.warn({ sessionId }, 'webContents 已销毁，停止推送流');
          await reader.cancel().catch(() => {
            // reader.cancel 可能因流已关闭而失败，忽略
          });
          controller.abort();
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

      // 6. token 使用量统计（AI SDK v7 原生支持）
      //    totalUsage 是 PromiseLike，流结束后才 resolve，不 await 避免阻塞 finally 清理
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
              'Chat token 使用量',
            );
          }
        })
        .catch(() => {
          // usage 读取失败，忽略
        });
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
        logger.error({ sessionId, errorCode: appError.code, error: appError }, '对话流异常结束');
      }
    } finally {
      // 无论正常/异常/abort，都从两个 Map 同步移除
      // P3-10：activeStreams 也需清空，dispose 通过 Promise.allSettled 等待其 resolve
      // CAS 检查：abort() 已立即删除 controller，若 startChat 写入了新 controller，
      // 引用比较不一致则跳过删除，避免误删新 controller（对齐 AgentService 实现）
      if (this.activeSessions.get(sessionId) === controller) {
        this.activeSessions.delete(sessionId);
      }
      this.activeStreams.delete(sessionId);

      // 性能埋点：总耗时
      const durationMs = Math.round(performance.now() - startTime);
      logger.info({ sessionId, durationMs }, 'Chat streamText 总耗时');
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
