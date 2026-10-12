import { APICallError } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getErrorStatus,
  getRetryAfterDelayMs,
  isReasonableRetryAfterMs,
  isRetryableError,
  resolveEnvRetryMaxRetries,
  resolveRetryDelay,
  resolveRetryOptions,
  retryWithBackoff,
} from './retry';

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

  it('瞬时网络错误码全集（连接拒绝/DNS 暂时失败/主机不可达）：可重试', () => {
    for (const code of [
      'ECONNREFUSED',
      'ECONNABORTED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EHOSTUNREACH',
      'ENETUNREACH',
    ]) {
      const error = Object.assign(new Error(`connect ${code}`), { code });
      expect(isRetryableError(error)).toBe(true);
    }
  });

  it('TypeError + cause 链连接拒绝（供应商短暂重启形态）：可重试——白名单收窄回归', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
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

  it('TypeError（fetch 失联形态）：可重试', () => {
    expect(isRetryableError(new TypeError('fetch failed'))).toBe(true);
  });

  it('TypeError + cause 链网络错误码（undici 真实形态）：可重试', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' }),
    });
    expect(isRetryableError(error)).toBe(true);
  });

  it('TypeError + cause 链 undici 超时错误码：可重试', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('headers timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
    });
    expect(isRetryableError(error)).toBe(true);
  });

  it('TypeError（编程错误形态，如 undefined is not a function）：不可重试', () => {
    expect(isRetryableError(new TypeError('Cannot read properties of undefined'))).toBe(false);
    expect(isRetryableError(new TypeError('x is not a function'))).toBe(false);
  });

  it('TypeError + cause 链错误码不可重试（EACCES）：不可重试', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    });
    expect(isRetryableError(error)).toBe(false);
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

  it('getRetryAfterDelayMs：retry-after-ms（毫秒形态）优先', () => {
    const error = createApiError(429, {
      responseHeaders: { 'retry-after': '30', 'retry-after-ms': '750' },
    });
    expect(getRetryAfterDelayMs(error)).toBe(750);
  });

  it('getRetryAfterDelayMs：retry-after-ms 非法时回落秒数头', () => {
    const error = createApiError(429, {
      responseHeaders: { 'retry-after': '2', 'retry-after-ms': 'abc' },
    });
    expect(getRetryAfterDelayMs(error)).toBe(2000);
  });

  it('getRetryAfterDelayMs：大小写变体头（Retry-After）也能读到', () => {
    const error = createApiError(429, { responseHeaders: { 'Retry-After': '5' } });
    expect(getRetryAfterDelayMs(error)).toBe(5000);
  });

  it('getRetryAfterDelayMs：HTTP 日期形态返回未来差值', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const error = createApiError(429, { responseHeaders: { 'retry-after': future } });
    const delta = getRetryAfterDelayMs(error);
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(10_000);
  });
});

describe('isReasonableRetryAfterMs（Retry-After 采纳窗口）', () => {
  it('窗口内（≤5 分钟）：采纳', () => {
    expect(isReasonableRetryAfterMs(30_000, 1500)).toBe(true);
    expect(isReasonableRetryAfterMs(5 * 60_000, 1500)).toBe(true);
  });

  it('超窗口但小于本地指数值（供应商要求比本地计划更短）：采纳', () => {
    expect(isReasonableRetryAfterMs(6 * 60_000, 7 * 60_000)).toBe(true);
  });

  it('超窗口且大于本地指数值：拒绝', () => {
    expect(isReasonableRetryAfterMs(6 * 60_000, 30_000)).toBe(false);
  });

  it('undefined / NaN / 负数：拒绝', () => {
    expect(isReasonableRetryAfterMs(undefined, 1500)).toBe(false);
    expect(isReasonableRetryAfterMs(Number.NaN, 1500)).toBe(false);
    expect(isReasonableRetryAfterMs(-100, 1500)).toBe(false);
  });
});

describe('resolveRetryDelay（延迟决策与来源诊断）', () => {
  it('provider_header：窗口内 Retry-After 采纳且不抖动', () => {
    const decision = resolveRetryDelay({
      error: createApiError(429, { responseHeaders: { 'retry-after': '2' } }),
      exponentialDelayMs: 1500,
      jitter: true,
    });
    expect(decision.delayMs).toBe(2000);
    expect(decision.jittered).toBe(false);
    expect(decision.source).toBe('provider_header');
  });

  it('x-should-retry: false 供应商显式否决：不重试（裁决收口在 isRetryableError）', () => {
    const error = createApiError(429, {
      responseHeaders: { 'retry-after': '2', 'x-should-retry': 'false' },
    });
    expect(isRetryableError(error)).toBe(false);
    // '0' 同样否决
    const zeroHeader = createApiError(429, { responseHeaders: { 'x-should-retry': '0' } });
    expect(isRetryableError(zeroHeader)).toBe(false);
  });

  it('header_unparsed_or_ignored：头存在但超窗口被拒', () => {
    const decision = resolveRetryDelay({
      error: createApiError(429, { responseHeaders: { 'retry-after': '3600' } }),
      exponentialDelayMs: 1500,
      jitter: false,
    });
    expect(decision.delayMs).toBe(1500);
    expect(decision.source).toBe('header_unparsed_or_ignored');
  });

  it('missing：无任何相关头', () => {
    const decision = resolveRetryDelay({
      error: createApiError(500),
      exponentialDelayMs: 1500,
      jitter: false,
    });
    expect(decision.delayMs).toBe(1500);
    expect(decision.source).toBe('missing');
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

  it('退避等待期间 abort：以中止原因 reject，不再发起下一次请求', async () => {
    const controller = new AbortController();
    const error = createApiError(500);
    const fn = vi.fn().mockRejectedValue(error);
    const promise = retryWithBackoff(fn, {
      maxAttempts: 5,
      initialDelayMs: 1000,
      jitter: false,
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(1);
    controller.abort();

    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    // 1 次失败 + 退避等待中被中止：不再有第二次请求
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
      jitter: false,
      onRetry,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(APICallError);

    await vi.advanceTimersByTimeAsync(2000);
    await assertion;

    const delays = onRetry.mock.calls.map((call) => call[0].delayMs);
    expect(delays).toEqual([100, 200, 250]);
  });

  it('jitter 默认开启：延迟落入 [0.5×, 1.0×) 区间且 jittered 标记为真', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(createApiError(500));
    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 100,
      onRetry,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(APICallError);

    await vi.advanceTimersByTimeAsync(2000);
    await assertion;

    expect(onRetry).toHaveBeenCalledTimes(2);
    // attempt 1 指数值 100 → [50,100]；attempt 2 指数值 200 → [100,200]
    const expectedBases = [100, 200];
    onRetry.mock.calls.forEach((call, i) => {
      const info = call[0] as { delayMs: number; jittered: boolean };
      const base = expectedBases[i] ?? 0;
      expect(info.delayMs).toBeGreaterThanOrEqual(Math.round(base * 0.5));
      expect(info.delayMs).toBeLessThanOrEqual(base);
      expect(info.jittered).toBe(true);
    });
  });

  it('Retry-After 优先：显式等待指示不被抖动缩短', async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(createApiError(429, { responseHeaders: { 'retry-after': '2' } }))
      .mockResolvedValueOnce('ok');
    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 1000,
      onRetry,
    });

    await vi.advanceTimersByTimeAsync(2500);
    await expect(promise).resolves.toBe('ok');

    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ delayMs: 2000, jittered: false }),
    );
  });

  it('jitter 显式关闭：延迟回到确定性指数曲线（jittered=false）', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(createApiError(500));
    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 100,
      jitter: false,
      onRetry,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(APICallError);

    await vi.advanceTimersByTimeAsync(2000);
    await assertion;

    for (const call of onRetry.mock.calls) {
      expect((call[0] as { jittered: boolean }).jittered).toBe(false);
    }
  });
});

describe('resolveRetryOptions / resolveEnvRetryMaxRetries（退避参数解析）', () => {
  it('无 options 无 env：默认值（7 次 / 1.5s / 30s / jitter 开）', () => {
    expect(resolveRetryOptions(undefined, {})).toEqual({
      maxAttempts: 7,
      initialDelayMs: 1500,
      maxDelayMs: 30_000,
      jitter: true,
    });
  });

  it('options 显式值优先于 env', () => {
    const env: Record<string, string> = {};
    env['CODE_AGENT_MODEL_RETRY_MAX_ATTEMPTS'] = '11';
    env['CODE_AGENT_MODEL_RETRY_INITIAL_DELAY_MS'] = '5000';
    const resolved = resolveRetryOptions({ maxAttempts: 3, initialDelayMs: 100 }, env);
    expect(resolved.maxAttempts).toBe(3);
    expect(resolved.initialDelayMs).toBe(100);
  });

  it('env 值在 options 缺席时生效', () => {
    const env: Record<string, string> = {};
    env['CODE_AGENT_MODEL_RETRY_MAX_ATTEMPTS'] = '11';
    env['CODE_AGENT_MODEL_RETRY_INITIAL_DELAY_MS'] = '5000';
    env['CODE_AGENT_MODEL_RETRY_MAX_DELAY_MS'] = '60000';
    const resolved = resolveRetryOptions(undefined, env);
    expect(resolved.maxAttempts).toBe(11);
    expect(resolved.initialDelayMs).toBe(5000);
    expect(resolved.maxDelayMs).toBe(60_000);
  });

  it('env 非法值（非数字/负数/空串）：静默忽略落默认', () => {
    for (const bad of ['abc', '-5', '', '  ']) {
      const env: Record<string, string> = {};
      env['CODE_AGENT_MODEL_RETRY_MAX_ATTEMPTS'] = bad;
      const resolved = resolveRetryOptions(undefined, env);
      expect(resolved.maxAttempts).toBe(7);
    }
  });

  it('env 小数：向下取整', () => {
    const env: Record<string, string> = {};
    env['CODE_AGENT_MODEL_RETRY_MAX_ATTEMPTS'] = '3.9';
    const resolved = resolveRetryOptions(undefined, env);
    expect(resolved.maxAttempts).toBe(3);
  });

  it('resolveEnvRetryMaxRetries：尝试数换算为重试次数；未配置回落 2', () => {
    const envFive: Record<string, string> = {};
    envFive['CODE_AGENT_MODEL_RETRY_MAX_ATTEMPTS'] = '5';
    expect(resolveEnvRetryMaxRetries(envFive)).toBe(4);
    const envOne: Record<string, string> = {};
    envOne['CODE_AGENT_MODEL_RETRY_MAX_ATTEMPTS'] = '1';
    expect(resolveEnvRetryMaxRetries(envOne)).toBe(0);
    const envBad: Record<string, string> = {};
    envBad['CODE_AGENT_MODEL_RETRY_MAX_ATTEMPTS'] = 'abc';
    expect(resolveEnvRetryMaxRetries(envBad)).toBe(2);
    expect(resolveEnvRetryMaxRetries({})).toBe(2);
  });
});
