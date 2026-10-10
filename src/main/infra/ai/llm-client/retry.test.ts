import { APICallError } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getErrorStatus, getRetryAfterDelayMs, isRetryableError, retryWithBackoff } from './retry';

function createApiError(
  statusCode: number | undefined,
  opts: { isRetryable?: boolean; responseHeaders?: Record<string, string> } = {},
): APICallError {
  return new APICallError({
    message: `HTTP ${String(statusCode)}`,
    url: 'https://api.example.com/v1/chat/completions',
    requestBodyValues: {},
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(opts.responseHeaders !== undefined ? { responseHeaders: opts.responseHeaders } : {}),
    ...(opts.isRetryable !== undefined ? { isRetryable: opts.isRetryable } : {}),
  });
}

describe('isRetryableError（可重试判定）', () => {
  it('429（限流）：可重试', () => {
    expect(isRetryableError(createApiError(429))).toBe(true);
  });

  it('503（服务不可用）：可重试', () => {
    expect(isRetryableError(createApiError(503))).toBe(true);
  });

  it('5xx 服务端错误：可重试', () => {
    expect(isRetryableError(createApiError(500))).toBe(true);
    expect(isRetryableError(createApiError(502))).toBe(true);
  });

  it('401/403（凭据错误）：不可重试', () => {
    expect(isRetryableError(createApiError(401))).toBe(false);
    expect(isRetryableError(createApiError(403))).toBe(false);
  });

  it('404（模型不存在）：不可重试', () => {
    expect(isRetryableError(createApiError(404))).toBe(false);
  });

  it('APICallError.isRetryable 标记（网络层错误）：可重试', () => {
    expect(isRetryableError(createApiError(undefined, { isRetryable: true }))).toBe(true);
    expect(isRetryableError(createApiError(undefined, { isRetryable: false }))).toBe(false);
  });

  it('Node 网络错误码（ECONNRESET）：可重试', () => {
    const error = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(isRetryableError(error)).toBe(true);
  });

  it('undici 超时错误码（UND_ERR_*）：可重试', () => {
    for (const code of [
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_SOCKET',
    ]) {
      const error = Object.assign(new Error(`timeout: ${code}`), { code });
      expect(isRetryableError(error)).toBe(true);
    }
  });

  it('非清单内的错误码：不可重试', () => {
    const error = Object.assign(new Error('boom'), { code: 'EACCES' });
    expect(isRetryableError(error)).toBe(false);
  });

  it('TypeError（fetch 失败）：可重试', () => {
    expect(isRetryableError(new TypeError('fetch failed'))).toBe(true);
  });

  it('普通 Error：不可重试', () => {
    expect(isRetryableError(new Error('boom'))).toBe(false);
  });
});

describe('getErrorStatus / getRetryAfterDelayMs（错误信息提取）', () => {
  it('getErrorStatus：提取 APICallError.statusCode', () => {
    expect(getErrorStatus(createApiError(429))).toBe(429);
    expect(getErrorStatus(createApiError(undefined))).toBeUndefined();
    expect(getErrorStatus(new Error('plain'))).toBeUndefined();
  });

  it('getRetryAfterDelayMs：秒数形式头 → 毫秒', () => {
    const error = createApiError(429, { responseHeaders: { 'retry-after': '30' } });
    expect(getRetryAfterDelayMs(error)).toBe(30_000);
  });

  it('getRetryAfterDelayMs：无头返回 undefined', () => {
    expect(getRetryAfterDelayMs(createApiError(429))).toBeUndefined();
  });

  it('getRetryAfterDelayMs：非 APICallError 返回 undefined', () => {
    expect(getRetryAfterDelayMs(new Error('plain'))).toBeUndefined();
  });
});

describe('retryWithBackoff（重试执行器）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('首次成功：不重试', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const promise = retryWithBackoff(fn, { maxAttempts: 3 });

    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('可重试错误：重试到成功', async () => {
    const fn = vi.fn().mockRejectedValueOnce(createApiError(500)).mockResolvedValueOnce('ok');
    const promise = retryWithBackoff(fn, { maxAttempts: 5, initialDelayMs: 100, maxDelayMs: 200 });

    await vi.advanceTimersByTimeAsync(200);
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('耗尽尝试次数：抛出最后一个错误', async () => {
    const error = createApiError(503);
    const fn = vi.fn().mockRejectedValue(error);
    const promise = retryWithBackoff(fn, { maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 200 });
    const assertion = expect(promise).rejects.toBe(error);

    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('不可重试错误：立即抛出，不重试', async () => {
    const error = createApiError(401);
    const fn = vi.fn().mockRejectedValue(error);
    const promise = retryWithBackoff(fn, { maxAttempts: 5, initialDelayMs: 100 });

    await expect(promise).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('abort 后：立即抛出，不重试', async () => {
    const controller = new AbortController();
    const error = createApiError(500);
    const fn = vi.fn().mockRejectedValue(error);
    const promise = retryWithBackoff(fn, {
      maxAttempts: 5,
      initialDelayMs: 100,
      signal: controller.signal,
    });
    controller.abort();
    const assertion = expect(promise).rejects.toBe(error);

    await vi.advanceTimersByTimeAsync(200);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('onRetry 遥测回调：携带 attempt / errorStatus / delayMs', async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(createApiError(429, { responseHeaders: { 'retry-after': '2' } }))
      .mockResolvedValueOnce('ok');
    const promise = retryWithBackoff(fn, {
      maxAttempts: 5,
      initialDelayMs: 1000,
      maxDelayMs: 10_000,
      onRetry,
    });

    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toBe('ok');

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        errorStatus: 429,
        delayMs: 2000,
      }),
    );
  });

  it('指数退避：延迟随尝试次数翻倍且上限截断', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(createApiError(500));
    const promise = retryWithBackoff(fn, {
      maxAttempts: 4,
      initialDelayMs: 100,
      maxDelayMs: 250,
      onRetry,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(APICallError);

    await vi.advanceTimersByTimeAsync(2000);
    await assertion;

    const delays = onRetry.mock.calls.map((call) => call[0].delayMs);
    expect(delays).toEqual([100, 200, 250]);
  });
});
