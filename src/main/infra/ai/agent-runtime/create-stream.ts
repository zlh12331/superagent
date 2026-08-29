// src/main/infra/ai/agent-runtime/create-stream.ts
// 请求级重试：streamText 创建 + 首 part 读取（agent/chat 主流程共用）
// ──────────────────────────────────────────────────────────────
// 背景：主回合（agent/chat）streamText 无重试——网络/认证/首包失败直接抛错。
// 重试语义（务实边界）：
// - 覆盖"创建 + 首 part 读取"：连接失败 / 认证失败 / 首包超时（请求级失败）
// - 首 part 成功后不重试：流中错误（半流/工具副作用已发生）重试会重复副作用
// - 只兜传输层失败：HTTP 类错误（429/5xx）的重试真源是 SDK 的 model call 级
//   maxRetries（每一步都生效且尊重 retry-after），本层再重试会把请求数放大成 N×M
//
// 调用方责任：
// - 重试后把 { reader, firstPart } 传入 TurnRunner.run（复用 reader，避免重复 getReader）
// ──────────────────────────────────────────────────────────────

import { APICallError, RetryError } from 'ai';

import { logger } from '../../../utils/logger';
import type { RetryAttemptInfo } from '../llm-client/retry';
import { isRetryableError, retryWithBackoff } from '../llm-client/retry';
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, readWithIdleTimeout } from './stream-reader';

/** 可转为 UIMessageStream 的 streamText 结果（agent/chat 共用形状） */
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
  // 首 part（重试回调闭包写入，调用级隔离，避免并发串扰）
  let firstPart: { done: boolean; value?: unknown } = { done: true };

  await retryWithBackoff(
    async () => {
      result = options.create();
      stream = result.toUIMessageStream();
      reader = stream.getReader();
      // 首读：请求级错误（连接/认证/首包超时）在此暴露，可重试
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
      // 主流程重试语义：只兜 SDK 覆盖不到的传输层失败（裸 TypeError / undici 网络错误码）。
      // HTTP 类错误（429/5xx/连接失败）已由 streamText 的 model call 级 maxRetries 重试：
      // - APICallError：SDK 重试真源（指数退避 + 按 retry-after 头定时长）
      // - RetryError：SDK 重试耗尽后的包装，再重试等于把两层尝试次数相乘
      // （side query 保持完整重试，见 llm-client.runSideQuery）
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
