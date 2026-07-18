// src/main/utils/retry.ts
// 指数退避重试工具
// 设计文档 §7.5 自动重试策略
//
// 仅对 retryable=true 的 AppError 重试（AI 限流、超时、PG 崩溃等）
// 指数退避 + 抖动：baseDelay * 2^(attempt-1) + random(500)
// 默认 maxAttempts: 3

import { AppError } from '@novel-writer/shared';

/**
 * 重试选项
 */
export interface RetryOptions {
  /** 最大尝试次数（含首次） */
  readonly maxAttempts: number;
  /** 基础延迟（毫秒），实际延迟 = baseDelay * 2^(attempt-1) + 抖动 */
  readonly baseDelay: number;
  /** 抖动上限（毫秒），默认 500 */
  readonly jitterMax?: number;
}

/**
 * 默认重试选项
 */
const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelay: 1000,
  jitterMax: 500,
};

/**
 * 判断错误是否可重试
 *
 * 仅 AppError 且 retryable=true 的错误可重试
 *
 * @param error 捕获到的未知错误
 * @returns 是否可重试
 */
export function isRetryableError(error: unknown): boolean {
  return error instanceof AppError && error.retryable;
}

/**
 * 指数退避重试
 *
 * 设计文档 §7.5：
 * - 仅对 retryable=true 的 AppError 重试
 * - 指数退避 + 抖动：baseDelay * 2^(attempt-1) + random(jitterMax)
 * - 默认 maxAttempts: 3
 *
 * @param fn 要重试的异步函数
 * @param options 重试选项
 * @returns 函数的成功返回值
 * @throws 最后一个错误（达到最大重试次数或非 retryable 错误）
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = DEFAULT_OPTIONS,
): Promise<T> {
  const { maxAttempts, baseDelay, jitterMax = 500 } = options;

  // 保存最后一次捕获的错误，用于最终抛出
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      // 非 retryable 错误立即抛出，不进行重试
      if (!isRetryableError(error)) {
        throw error;
      }

      // 最后一次尝试不再等待，直接跳出循环抛出错误
      if (attempt >= maxAttempts) {
        break;
      }

      // 指数退避 + 抖动：避免多个客户端同步重试造成"惊群效应"
      const backoff = baseDelay * 2 ** (attempt - 1);
      const jitter = Math.random() * jitterMax;
      const delay = backoff + jitter;

      await sleep(delay);
    }
  }

  // 达到最大重试次数后抛出最后一个错误
  // 此处 lastError 一定不为 undefined（因为只有 catch 块中才会 break）
  throw lastError;
}

/**
 * Promise 化的 setTimeout
 *
 * @param ms 延迟毫秒数
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
