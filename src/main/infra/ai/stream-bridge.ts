// src/main/infra/ai/stream-bridge.ts
// 流式响应 → IPC 事件桥接
// 设计文档 §5.5 流式响应中断设计
//
// 职责：
// 1. 管理活跃流 Map<sessionId, AbortController>
// 2. 迭代 AsyncIterable<T>，逐 chunk 推送到渲染层
// 3. abort(sessionId) 中断指定流
// 4. 流结束/中断/异常时清理 controller
// 5. 推送前检查 webContents.isDestroyed，避免窗口关闭后报错
// 6. getStreamBridge 单例访问器（活跃流注册表必须全进程共享，否则跨模块 abort 失效）
//
// 解耦设计：
// - 不依赖 openai SDK 类型，接收任意 AsyncIterable<T>
// - 不依赖具体 IPC_CHANNELS 常量，channel 由调用方传入（string 类型）
//   这样 StreamBridge 可被任意业务域复用，不与特定 channel 表耦合

import type { WebContents } from 'electron';
import { logger } from '../../utils/logger';

/**
 * 简单的 Promise 链式互斥锁
 *
 * 用于保护 activeStreams Map 的并发访问。
 * 多个异步操作（streamToWebContents 的 set、abort、abortAll、delete）可能同时发生，
 * 需要确保对 Map 的操作是原子的，避免并发修改导致的数据不一致。
 */
class SimpleMutex {
  private lock: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const next = new Promise<void>((resolveNext) => {
        resolve(resolveNext);
      });
      this.lock = this.lock.then(() => next);
    });
  }
}

/**
 * 流式 chunk 类型约束
 *
 * openai SDK 的 chunk 是对象，streamToWebContents 会通过 String(chunk) 转换
 * 调用方可传入字符串流或对象流，最终通过 chunkToString() 统一为字符串
 */
export type StreamChunk = unknown;

/**
 * streamToWebContents 参数
 *
 * channel 类型为 string 而非具体字面量联合：
 * 调用方负责传入合法的 IPC channel 字符串（如 'chat:stream:chunk'），
 * StreamBridge 本身不与任何业务 channel 表耦合。
 */
export interface StreamToWebContentsOptions<T extends StreamChunk = StreamChunk> {
  /** 会话 ID（用于关联 abort 请求） */
  readonly sessionId: string;
  /** 目标 webContents（接收 chunk 事件） */
  readonly webContents: WebContents;
  /** 流式数据源（openai SDK 的 stream 或自定义 AsyncIterable） */
  readonly stream: AsyncIterable<T>;
  /** chunk 推送 channel（如 'chat:stream:chunk'） */
  readonly chunkChannel: string;
  /** 流结束 channel（如 'chat:stream:end'） */
  readonly endChannel: string;
  /** 流异常 channel（如 'chat:stream:error'） */
  readonly errorChannel: string;
}

/**
 * 流式响应桥接器
 *
 * @example
 * ```ts
 * const bridge = new StreamBridge();
 * const stream = await openaiClient.chat.completions.create({ ..., stream: true });
 * const fullText = await bridge.streamToWebContents({
 *   sessionId: 'xxx',
 *   webContents: win.webContents,
 *   stream,
 *   chunkChannel: 'chat:stream:chunk',
 *   endChannel: 'chat:stream:end',
 *   errorChannel: 'chat:stream:error',
 * });
 * ```
 */
export class StreamBridge {
  private readonly activeStreams = new Map<string, AbortController>();
  private readonly lock = new SimpleMutex();

  /**
   * 迭代流并推送到 webContents
   *
   * @returns 完整文本（所有 chunk 拼接）
   *
   * 流结束（正常）：推 end 事件，清理 controller
   * 流结束（abort）：推 error 事件（error: 'aborted'），不 rethrow
   *   注意：abort 可能发生在 next() 调用期间（for await 未进入循环体就退出），
   *   因此需要在循环退出后再次检查 controller.signal.aborted
   * 流异常：推 error 事件，清理 controller，rethrow
   * webContents 销毁：不推送但仍消费完流以释放底层资源
   */
  async streamToWebContents<T extends StreamChunk = StreamChunk>(
    options: StreamToWebContentsOptions<T>,
  ): Promise<string> {
    const { sessionId, webContents, stream, chunkChannel, endChannel, errorChannel } = options;

    const controller = new AbortController();
    await this.lock.runExclusive(() => {
      this.activeStreams.set(sessionId, controller);
    });

    let fullText = '';
    let wasAborted = false;

    try {
      for await (const chunk of stream) {
        // 中断检查（abort 发生在上一轮 next() 返回后）
        if (controller.signal.aborted) {
          wasAborted = true;
          logger.info({ sessionId }, '流式响应被中断');
          break;
        }

        // 累加完整文本（即使 webContents 销毁仍消费流以释放底层资源）
        const chunkStr = chunkToString(chunk);
        fullText += chunkStr;

        // webContents 已销毁时不推送，但继续消费流
        if (!webContents.isDestroyed()) {
          this.emit(webContents, chunkChannel, { sessionId, chunk: chunkStr });
        }
      }

      // abort 可能发生在 next() 调用期间（循环未进入循环体就退出）
      // 此时 wasAborted 仍为 false，需要通过 controller.signal.aborted 兜底
      if (controller.signal.aborted) {
        wasAborted = true;
      }

      // 循环退出后统一处理 abort / end 事件
      if (wasAborted) {
        this.emit(webContents, errorChannel, { sessionId, error: 'aborted' });
        logger.info({ sessionId }, '流式响应被中断');
      } else if (!webContents.isDestroyed()) {
        this.emit(webContents, endChannel, { sessionId, fullText });
        logger.info({ sessionId, length: fullText.length }, '流式响应完成');
      }
    } catch (error: unknown) {
      // 异常时推 error 事件
      const message = error instanceof Error ? error.message : String(error);
      this.emit(webContents, errorChannel, { sessionId, error: message });
      logger.error({ sessionId, err: error }, '流式响应异常');
      throw error;
    } finally {
      await this.lock.runExclusive(() => {
        this.activeStreams.delete(sessionId);
      });
    }

    return fullText;
  }

  /**
   * 中断指定 session 的流
   */
  async abort(sessionId: string): Promise<void> {
    const controller = await this.lock.runExclusive(() => {
      return this.activeStreams.get(sessionId);
    });
    if (controller) {
      controller.abort();
      logger.info({ sessionId }, '请求中断流式响应');
    }
  }

  /**
   * 检查指定 session 是否有活跃流
   */
  async has(sessionId: string): Promise<boolean> {
    return this.lock.runExclusive(() => {
      return this.activeStreams.has(sessionId);
    });
  }

  /**
   * 中断所有活跃流
   *
   * 用于应用退出时清理
   */
  async abortAll(): Promise<void> {
    const controllers = await this.lock.runExclusive(() => {
      const entries = Array.from(this.activeStreams.entries());
      return entries;
    });
    for (const [sessionId, controller] of controllers) {
      controller.abort();
      logger.info({ sessionId }, '应用退出，中断流式响应');
    }
  }

  /**
   * 安全推送 IPC 事件
   *
   * 推送前检查 webContents.isDestroyed
   */
  private emit(webContents: WebContents, channel: string, payload: unknown): void {
    if (webContents.isDestroyed()) {
      return;
    }
    webContents.send(channel, payload);
  }
}

/**
 * chunk 转字符串
 *
 * - string 直接返回
 * - 其他类型 JSON.stringify
 */
function chunkToString(chunk: unknown): string {
  if (typeof chunk === 'string') {
    return chunk;
  }
  return JSON.stringify(chunk);
}

/** 缓存的 StreamBridge 单例 */
let cachedBridge: StreamBridge | null = null;

/**
 * 获取 StreamBridge 单例
 *
 * activeStreams 注册表必须全主进程共享：
 * agent.service 发起的流注册在单例内，chat.service 的 stopChatGeneration
 * 才能通过同一注册表找到并 abort 对应 sessionId 的流。
 */
export function getStreamBridge(): StreamBridge {
  if (cachedBridge === null) {
    cachedBridge = new StreamBridge();
  }
  return cachedBridge;
}

/**
 * 重置 StreamBridge 单例（仅测试用）
 */
export function resetStreamBridge(): void {
  cachedBridge = null;
}
