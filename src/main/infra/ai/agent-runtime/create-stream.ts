// create-stream.ts：模型流创建（带重试）——可重试错误（429/网络）重建流直到拿到首 part；
// 首部分已抢读交给调用方（38 号时序约定：TurnRunner 消费 firstPart）
import { APICallError, RetryError } from 'ai';

import { logger } from '../../../utils/logger';
import type { RetryAttemptInfo } from '../llm-client/retry';
import { isRetryableError, retryWithBackoff } from '../llm-client/retry';
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, readWithIdleTimeout } from './stream-reader';

/** 可产生 UI 消息流的对象（AI SDK streamText 等结果的形状约定） */
export interface MessageStreamSource {
  // biome-ignore lint/style/useNamingConvention: SDK 方法名 toUIMessageStream（AI SDK 约定，不可改名）
  toUIMessageStream(): ReadableStream<unknown>;
}

/** 创建流的结果：原始 result + 流 + 已抢读的 reader/首 part（TurnRunner 从 firstPart 接力） */
export interface CreatedStream<T extends MessageStreamSource = MessageStreamSource> {
  readonly result: T;
  readonly stream: ReadableStream<unknown>;
  readonly reader: ReadableStreamDefaultReader<unknown>;
  readonly firstPart: { done: boolean; value?: unknown };
}

export interface CreateStreamWithRetryOptions<T extends MessageStreamSource = MessageStreamSource> {
  readonly create: () => T;
  readonly controller: AbortController;
  readonly idleTimeoutMs?: number;
  readonly maxAttempts?: number;
}

/**
 * 创建模型流（带重试与首 part 预读）：每次尝试先拿首 part 才算成功——
 * 「连接建立但流立即断」这类半途失败也纳入重试判定
 */
export async function createStreamWithRetry<T extends MessageStreamSource>(
  options: CreateStreamWithRetryOptions<T>,
): Promise<CreatedStream<T>> {
  let result: T | undefined;
  let stream: ReadableStream<unknown> | undefined;
  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  let firstPart: { done: boolean; value?: unknown } = { done: true };

  await retryWithBackoff(
    async () => {
      result = options.create();
      stream = result.toUIMessageStream();
      reader = stream.getReader();
      const first = await readWithIdleTimeout(
        reader,
        options.controller,
        options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      );
      firstPart = first;
    },
    {
      maxAttempts: options.maxAttempts ?? 3,
      ...(options.controller.signal !== undefined ? { signal: options.controller.signal } : {}),
      shouldRetryOnError: (error: unknown) => {
        if (APICallError.isInstance(error) || RetryError.isInstance(error)) {
          return false;
        }
        return isRetryableError(error);
      },
      onRetry: (info: RetryAttemptInfo) => {
        logger.warn(
          { attempt: info.attempt, errorStatus: info.errorStatus, delayMs: info.delayMs },
          '主流程首读重试',
        );
      },
    },
  );

  if (result === undefined || stream === undefined || reader === undefined) {
    throw new Error('createStreamWithRetry：流未创建（重试链路异常）');
  }
  return { result, stream, reader, firstPart };
}
