import { APICallError, RetryError } from 'ai';

import { logger } from '../../../utils/logger';
import type { RetryAttemptInfo } from '../llm-client/retry';
import { isRetryableError, retryWithBackoff } from '../llm-client/retry';
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, readWithIdleTimeout } from './stream-reader';

/** 可转为 UIMessageStream 的 streamText 结果（主回合链路共用形状） */
export interface MessageStreamSource {
  // biome-ignore lint/style/useNamingConvention: SDK 方法名 toUIMessageStream（AI SDK 约定，不可改名）
  toUIMessageStream(): ReadableStream<unknown>;
}

/** 创建 + 首读结果 */
export interface CreatedStream<T extends MessageStreamSource = MessageStreamSource> {
  /** 原始 streamText 结果（调用方取 totalUsage 等） */
  readonly result: T;
  /** UIMessageStream（供 TurnRunner 消费；reader 已预读首 part） */
  readonly stream: ReadableStream<unknown>;
  /** 复用 reader（已读首 part；TurnRunner 接续消费） */
  readonly reader: ReadableStreamDefaultReader<unknown>;
  /** 首 part 读取结果（重试内完成；{ done: true } 表示流立即结束） */
  readonly firstPart: { done: boolean; value?: unknown };
}

/** 创建 + 首读重试参数 */
export interface CreateStreamWithRetryOptions<T extends MessageStreamSource = MessageStreamSource> {
  /** 创建 streamText 结果（每次尝试重新创建） */
  readonly create: () => T;
  /** 中断控制器（首读超时/用户中断共用） */
  readonly controller: AbortController;
  /** 流空闲超时（默认 10 分钟，与 TurnRunner 一致） */
  readonly idleTimeoutMs?: number;
  /** 重试次数上限（默认 3 次尝试；仅作用于传输层失败，HTTP 类由 SDK 重试） */
  readonly maxAttempts?: number;
}

/**
 * 创建流 + 首 part 读取（带请求级重试）
 *
 * @throws 重试耗尽后抛最后错误（首读超时抛 AppError(AI_TIMEOUT)，由上层分类）
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
