import { APICallError } from 'ai';

export const RETRYABLE_NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function getErrorCode(error: unknown): string | undefined {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
  }
  return undefined;
}

export function getErrorStatus(error: unknown): number | undefined {
  if (error instanceof APICallError) {
    return error.statusCode;
  }
  return undefined;
}

export function isRetryableError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status !== undefined) {
    return status === 429 || (status >= 500 && status < 600);
  }
  if (error instanceof APICallError) {
    return error.isRetryable === true;
  }
  const code = getErrorCode(error);
  if (code !== undefined && RETRYABLE_NETWORK_ERROR_CODES.has(code)) {
    return true;
  }
  if (error instanceof TypeError) {
    return true;
  }
  return false;
}

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

export interface RetryAttemptInfo {
  readonly attempt: number;
  readonly error: unknown;
  readonly errorStatus: number | undefined;
  readonly delayMs: number;
}

export interface RetryOptions {
  readonly maxAttempts?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly shouldRetryOnError?: (error: unknown) => boolean;
  readonly onRetry?: (info: RetryAttemptInfo) => void;
  readonly signal?: AbortSignal;
}

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
      if (options.signal?.aborted === true) {
        throw error;
      }
      if (attempt >= maxAttempts || !shouldRetry(error)) {
        throw error;
      }
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
