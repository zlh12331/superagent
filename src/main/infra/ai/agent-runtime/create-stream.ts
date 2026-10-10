import { APICallError, RetryError } from 'ai';

import { logger } from '../../../utils/logger';
import type { RetryAttemptInfo } from '../llm-client/retry';
import { isRetryableError, retryWithBackoff } from '../llm-client/retry';
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, readWithIdleTimeout } from './stream-reader';

export interface MessageStreamSource {
  // biome-ignore lint/style/useNamingConvention: SDK 方法名 toUIMessageStream（AI SDK 约定，不可改名）
  toUIMessageStream(): ReadableStream<unknown>;
}

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
