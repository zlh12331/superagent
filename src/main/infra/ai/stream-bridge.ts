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
//
// 解耦：不依赖 openai SDK 类型，接收任意 AsyncIterable<T>

import type { IpcChannel } from '@novel-writer/shared';
import type { WebContents } from 'electron';
import { logger } from '../../utils/logger';

/**
 * 流式 chunk 类型约束
 *
 * openai SDK 的 chunk 是对象，streamToWebContents 会通过 String(chunk) 转换
 * 调用方可传入字符串流或对象流，最终通过 chunkToString() 统一为字符串
 */
export type StreamChunk = unknown;

/**
 * streamToWebContents 参数
 */
export interface StreamToWebContentsOptions<T extends StreamChunk = StreamChunk> {
  /** 会话 ID（用于关联 abort 请求） */
  readonly sessionId: string;
  /** 目标 webContents（接收 chunk 事件） */
  readonly webContents: WebContents;
  /** 流式数据源（openai SDK 的 stream 或自定义 AsyncIterable） */
  readonly stream: AsyncIterable<T>;
  /** chunk 推送 channel（如 IPC_CHANNELS.CHAT_STREAM_CHUNK） */
  readonly chunkChannel: IpcChannel;
  /** 流结束 channel（如 IPC_CHANNELS.CHAT_STREAM_END） */
  readonly endChannel: IpcChannel;
  /** 流异常 channel（如 IPC_CHANNELS.CHAT_STREAM_ERROR） */
  readonly errorChannel: IpcChannel;
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
 *   chunkChannel: IPC_CHANNELS.CHAT_STREAM_CHUNK,
 *   endChannel: IPC_CHANNELS.CHAT_STREAM_END,
 *   errorChannel: IPC_CHANNELS.CHAT_STREAM_ERROR,
 * });
 * ```
 */
export class StreamBridge {
  private readonly activeStreams = new Map<string, AbortController>();

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
    this.activeStreams.set(sessionId, controller);

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
      this.activeStreams.delete(sessionId);
    }

    return fullText;
  }

  /**
   * 中断指定 session 的流
   */
  abort(sessionId: string): void {
    const controller = this.activeStreams.get(sessionId);
    if (controller) {
      controller.abort();
      logger.info({ sessionId }, '请求中断流式响应');
    }
  }

  /**
   * 检查指定 session 是否有活跃流
   */
  has(sessionId: string): boolean {
    return this.activeStreams.has(sessionId);
  }

  /**
   * 中断所有活跃流
   *
   * 用于应用退出时清理
   */
  abortAll(): void {
    for (const [sessionId, controller] of this.activeStreams) {
      controller.abort();
      logger.info({ sessionId }, '应用退出，中断流式响应');
    }
  }

  /**
   * 安全推送 IPC 事件
   *
   * 推送前检查 webContents.isDestroyed
   */
  private emit(webContents: WebContents, channel: IpcChannel, payload: unknown): void {
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
