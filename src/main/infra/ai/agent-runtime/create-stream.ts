// create-stream.ts：模型流创建（带重试）——可重试错误重建流直到拿到「重试边界」part；
// 前奏缓冲（结构事件/空 delta）跨重试存活，边界到达后经回注流按原序交给消费方
// （TurnRunner 消费 firstPart 后从回注流接力——38 号时序约定不变）
import { APICallError, RetryError } from 'ai';

import { logger } from '../../../utils/logger';
import type { RetryAttemptInfo } from '../llm-client/retry';
import { isRetryableError, retryWithBackoff } from '../llm-client/retry';
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, readWithIdleTimeout } from './stream-reader';
import { isRetrySafePreludePart } from './stream-retry-boundary';

/** 可产生 UI 消息流的对象（AI SDK streamText 等结果的形状约定） */
export interface MessageStreamSource {
  // biome-ignore lint/style/useNamingConvention: SDK 方法名 toUIMessageStream（AI SDK 约定，不可改名）
  toUIMessageStream(): ReadableStream<unknown>;
}

/** 创建流的结果：原始 result + 流 + 已抢读的 reader/首 part（TurnRunner 从 firstPart 接力） */
export interface CreatedStream<T extends MessageStreamSource = MessageStreamSource> {
  readonly result: T;
  readonly stream: ReadableStream<unknown>;
  /** 消费方实际应读的 reader——边界前有前奏时是回注流（前奏按原序先吐），否则是原始 reader */
  readonly reader: ReadableStreamDefaultReader<unknown>;
  readonly firstPart: { done: boolean; value?: unknown };
  /** 边界前缓冲的前奏事件数（观测：无感重试窗口的覆盖面；0 = 首个事件即边界） */
  readonly preludeBufferedCount: number;
  /** 达到边界前的尝试次数（1 = 首次尝试即见边界；>1 = 中途重建过流） */
  readonly attemptsToBoundary: number;
}

export interface CreateStreamWithRetryOptions<T extends MessageStreamSource = MessageStreamSource> {
  readonly create: () => T;
  readonly controller: AbortController;
  readonly idleTimeoutMs?: number;
  readonly maxAttempts?: number;
  /** 限流上报：重试观测到 429 时回调（durationMs = 建议冷却时长；缺省不上报） */
  readonly onRateLimited?: (durationMs: number) => void;
}

/** 读单次尝试直到「重试边界」：前奏（结构/空 delta）即时追加到 out（错误上抛时已读到的
 * 前奏不丢——跨尝试保留的关键），读到边界事件或流结束才返回 */
async function readToBoundary(
  reader: ReadableStreamDefaultReader<unknown>,
  controller: AbortController,
  idleTimeoutMs: number,
  out: unknown[],
): Promise<{ boundary: { done: boolean; value?: unknown } }> {
  for (;;) {
    const part = await readWithIdleTimeout(reader, controller, idleTimeoutMs);
    if (part.done === true) {
      return { boundary: part };
    }
    if (isRetrySafePreludePart(part.value)) {
      out.push(part.value);
      continue;
    }
    return { boundary: part };
  }
}

/**
 * 前奏回注流：先吐 prelude 数组（原序）→ 再吐边界事件（已被 readToBoundary 读出，
 * 不在 sourceReader 里）→ 最后透传 source reader 的后续输出。
 */
function requeuePrelude(
  sourceStream: ReadableStream<unknown>,
  sourceReader: ReadableStreamDefaultReader<unknown>,
  prelude: readonly unknown[],
  boundaryValue: unknown,
): ReadableStreamDefaultReader<unknown> {
  let preludeIndex = 0;
  let boundaryForwarded = false;
  const wrapped = new ReadableStream<unknown>({
    async pull(controller) {
      if (preludeIndex < prelude.length) {
        controller.enqueue(prelude[preludeIndex]);
        preludeIndex += 1;
        return;
      }
      if (!boundaryForwarded) {
        // 边界事件已被 readToBoundary 读出（不在 sourceReader 里）——先回注它
        boundaryForwarded = true;
        if (boundaryValue !== undefined) {
          controller.enqueue(boundaryValue);
        }
        return;
      }
      const next = await sourceReader.read();
      if (next.done === true) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    cancel(reason) {
      return sourceStream.cancel(reason);
    },
  });
  return wrapped.getReader();
}

/**
 * 创建模型流（带重试与重试边界预读）：
 * - 重试边界 = 首个真实 provider 内容事件（非空 delta/tool-call/finish/error 等）——
 *   边界前（结构事件/空 delta 窗口内）断流直接重建流，用户无感，已缓冲前奏跨尝试保留；
 * - 边界后断流不再本层重试（内容已可能到达渲染层，重建会重复输出）
 */
export async function createStreamWithRetry<T extends MessageStreamSource>(
  options: CreateStreamWithRetryOptions<T>,
): Promise<CreatedStream<T>> {
  let result: T | undefined;
  let stream: ReadableStream<unknown> | undefined;
  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  let firstPart: { done: boolean; value?: unknown } = { done: true };
  let preludeBufferedCount = 0;
  let attemptsToBoundary = 0;
  const bufferedPrelude: unknown[] = [];

  await retryWithBackoff(
    async () => {
      result = options.create();
      stream = result.toUIMessageStream();
      const rawReader = stream.getReader();
      attemptsToBoundary += 1; // 每次尝试开始即计数（错误路径也算一次尝试）
      // 前奏直接写入 bufferedPrelude（错误上抛时已读到的保留——跨尝试保留的关键）
      const attempt = await readToBoundary(
        rawReader,
        options.controller,
        options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        bufferedPrelude,
      );
      preludeBufferedCount = bufferedPrelude.length;

      if (bufferedPrelude.length === 0) {
        // 无前奏：原始 reader 即消费 reader，首 part = 边界事件
        reader = rawReader;
        firstPart = attempt.boundary;
        return;
      }

      // 有前奏：回注流先吐前奏（原序），再透传边界及其后。
      // firstPart 必须从回注流**读出**（消费掉首格）——TurnRunner 处理完 firstPart
      // 后从 reader 接力，若只复制不消费，首格会被重复投递。
      // 快照传入（requeuePrelude 持原数组引用，随后 length=0 会把它清空）
      reader = requeuePrelude(stream, rawReader, [...bufferedPrelude], attempt.boundary.value);
      const first = await reader.read();
      firstPart = first;
      bufferedPrelude.length = 0;
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
          {
            attempt: info.attempt,
            errorStatus: info.errorStatus,
            delayMs: info.delayMs,
            preludeBuffered: bufferedPrelude.length,
          },
          '主流程首读重试',
        );
        if (info.errorStatus === 429 && options.onRateLimited !== undefined) {
          options.onRateLimited(info.delayMs);
        }
      },
    },
  );

  if (result === undefined || stream === undefined || reader === undefined) {
    throw new Error('createStreamWithRetry：流未创建（重试链路异常）');
  }
  return { result, stream, reader, firstPart, preludeBufferedCount, attemptsToBoundary };
}
