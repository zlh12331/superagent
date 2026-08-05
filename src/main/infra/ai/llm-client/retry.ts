// src/main/infra/ai/llm-client/retry.ts
// LLM 调用重试层：错误码感知 + 指数退避 + 遥测回调
// ──────────────────────────────────────────────────────────────
// 职责：
// - 从错误中提取 HTTP 状态码（AI SDK APICallError）
// - 判定是否可重试（429 / 503 Retry-After / 5xx / 网络层错误）
// - 指数退避重试（默认 7 次、1.5s 初始、30s 上限），支持 Retry-After 头覆盖
// - onRetry 遥测回调（Otel span / logger 由调用方注入，本层零耦合）
// - abortSignal 贯穿：中断时立即抛出，不重试
//
// 设计（对标 qwen-code utils/retry.ts）：
// - 纯函数 + DI：不依赖 config / telemetry / logger
// - shouldRetryOnError 可覆盖（错误判定单一语义）
// - Retry-After 头优先于指数退避（尊重服务端指示）
// ──────────────────────────────────────────────────────────────

import { APICallError } from 'ai';

/**
 * 网络层可重试错误码清单（移植自 qwen-code stream-transport-retry.ts）
 *
 * Node/undici 在连接重置、超时、socket 异常时抛出带 code 的错误：
 * - ECONNRESET：连接被重置
 * - ETIMEDOUT：连接超时
 * - UND_ERR_BODY_TIMEOUT / UND_ERR_CONNECT_TIMEOUT / UND_ERR_HEADERS_TIMEOUT：
 *   undici 各阶段超时
 * - UND_ERR_SOCKET：socket 异常
 *
 * 这些错误没有 HTTP 状态码，也不会被 AI SDK 包装为 APICallError，
 * 需要按 error.code 识别后才能纳入重试。
 */
export const RETRYABLE_NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * 从错误中提取 Node 错误码（error.code，如 'ECONNRESET' / 'UND_ERR_SOCKET'）
 */
export function getErrorCode(error: unknown): string | undefined {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
  }
  return undefined;
}

/**
 * 从错误中提取 HTTP 状态码
 *
 * AI SDK 的 APICallError 携带 statusCode；非 HTTP 错误（网络中断等）返回 undefined。
 */
export function getErrorStatus(error: unknown): number | undefined {
  if (error instanceof APICallError) {
    return error.statusCode;
  }
  return undefined;
}

/**
 * 判定错误是否可重试（瞬态错误）
 *
 * 可重试集合：
 * - HTTP 429（限流）/ 503（服务不可用，通常带 Retry-After）
 * - HTTP 5xx（服务端瞬时故障）
 * - APICallError.isRetryable（AI SDK 标记的网络层错误）
 * - Node 网络错误码（ECONNRESET / ETIMEDOUT / UND_ERR_*，连接重置与各阶段超时）
 * - TypeError（Node.js fetch 失败，未被 SDK 包装的边缘情况）
 *
 * 不可重试：401/403（凭据错误）、404（模型不存在）、400（请求错误）等。
 */
export function isRetryableError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status !== undefined) {
    return status === 429 || (status >= 500 && status < 600);
  }
  if (error instanceof APICallError) {
    return error.isRetryable === true;
  }
  // Node/undici 网络层错误码（连接重置、各阶段超时）
  const code = getErrorCode(error);
  if (code !== undefined && RETRYABLE_NETWORK_ERROR_CODES.has(code)) {
    return true;
  }
  if (error instanceof TypeError) {
    return true;
  }
  return false;
}

/**
 * 从错误中解析 Retry-After 头（服务端指示的等待时长）
 *
 * 支持秒数形式（'30'）。HTTP-date 形式（'Wed, 21 Oct 2015 07:28:00 GMT'）
 * 解析成本高且极少返回，返回 undefined 走指数退避。
 *
 * @returns 毫秒数；无 Retry-After 头时返回 undefined
 */
export function getRetryAfterDelayMs(error: unknown): number | undefined {
  if (!(error instanceof APICallError)) {
    return undefined;
  }
  const headers = error.responseHeaders;
  if (headers === undefined) {
    return undefined;
  }
  const retryAfter = headers['retry-after'] ?? headers['Retry-After'];
  if (retryAfter === undefined) {
    return undefined;
  }
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  return undefined;
}

/**
 * 单次重试尝试的信息（onRetry 回调参数）
 */
export interface RetryAttemptInfo {
  /** 已失败的尝试次数（1-based） */
  readonly attempt: number;
  readonly error: unknown;
  /** 错误 HTTP 状态码（非 HTTP 错误为 undefined） */
  readonly errorStatus: number | undefined;
  /** 本次重试前的等待毫秒数 */
  readonly delayMs: number;
}

/**
 * 重试选项
 */
export interface RetryOptions {
  /** 最大尝试次数（含首次，默认 7） */
  readonly maxAttempts?: number;
  /** 初始退避毫秒数（默认 1500） */
  readonly initialDelayMs?: number;
  /** 最大退避毫秒数（默认 30000） */
  readonly maxDelayMs?: number;
  /** 可重试判定（默认 isRetryableError） */
  readonly shouldRetryOnError?: (error: unknown) => boolean;
  /** 每次重试前的遥测回调（Otel span / logger 由调用方注入） */
  readonly onRetry?: (info: RetryAttemptInfo) => void;
  /** 中断信号（abort 后立即抛出，不重试） */
  readonly signal?: AbortSignal;
}

/**
 * 指数退避重试执行器
 *
 * @param fn 被重试的异步调用（必须幂等）
 * @param options 重试选项
 * @returns fn 的成功结果；耗尽尝试次数或不可重试错误时抛出原错误
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 7;
  const initialDelayMs = options.initialDelayMs ?? 1500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const shouldRetry = options.shouldRetryOnError ?? isRetryableError;

  let attempt = 1;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      // 中断信号：不重试，立即抛出（用户主动停止）
      if (options.signal?.aborted === true) {
        throw error;
      }
      if (attempt >= maxAttempts || !shouldRetry(error)) {
        throw error;
      }
      // Retry-After 头优先，否则指数退避（上限截断）
      const retryAfterMs = getRetryAfterDelayMs(error);
      const delayMs = retryAfterMs ?? Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
      options.onRetry?.({
        attempt,
        error,
        errorStatus: getErrorStatus(error),
        delayMs,
      });
      await sleep(delayMs, options.signal);
      attempt += 1;
    }
  }
}

/**
 * 可中断的延时（abort 时立即返回）
 */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Promise((resolve) => {
    const timeoutId = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeoutId);
        resolve();
      },
      { once: true },
    );
  });
}
