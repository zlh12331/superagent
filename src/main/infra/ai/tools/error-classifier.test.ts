import {
  AppError,
  ErrorCode,
  ModelErrorCode,
  ModelFailureReason,
  ModelRetryReason,
} from '@code-agent/shared/main';
import { APICallError, LoadAPIKeyError } from 'ai';
import { describe, expect, it } from 'vitest';
import { classifyError, classifyModelFailure, isAbortError } from './error-classifier';

function createApiError(statusCode: number | undefined, isRetryable: boolean): APICallError {
  return new APICallError({
    url: 'https://api.example.com/v1/chat/completions',
    ...(statusCode !== undefined ? { statusCode } : {}),
    responseHeaders: {},
    requestBodyValues: {},
    message: `HTTP ${statusCode ?? 'unknown'} error`,
    isRetryable,
  });
}

describe('isAbortError', () => {
  it('AbortError：返回 true', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
  });

  it('普通 Error：返回 false', () => {
    expect(isAbortError(new Error('boom'))).toBe(false);
  });

  it('非 Error 值：返回 false', () => {
    expect(isAbortError('string')).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});

describe('classifyError', () => {
  it('AppError：直接透传（不包装）', () => {
    const original = new AppError(ErrorCode.TOOL_NOT_FOUND, '工具不存在');
    const result = classifyError(original);
    expect(result).toBe(original);
    expect(result.code).toBe(ErrorCode.TOOL_NOT_FOUND);
  });

  it('APICallError 401：→ AI_API_KEY_INVALID', () => {
    const result = classifyError(createApiError(401, false));
    expect(result.code).toBe(ErrorCode.AI_API_KEY_INVALID);
  });

  it('APICallError 403：→ AI_API_KEY_INVALID', () => {
    expect(classifyError(createApiError(403, false)).code).toBe(ErrorCode.AI_API_KEY_INVALID);
  });

  it('APICallError 402：→ AI_BALANCE_INSUFFICIENT（账户余额不足）', () => {
    expect(classifyError(createApiError(402, false)).code).toBe(ErrorCode.AI_BALANCE_INSUFFICIENT);
  });

  it('APICallError 404：→ AI_MODEL_ERROR', () => {
    expect(classifyError(createApiError(404, false)).code).toBe(ErrorCode.AI_MODEL_ERROR);
  });

  it('APICallError 408：→ AI_TIMEOUT', () => {
    expect(classifyError(createApiError(408, false)).code).toBe(ErrorCode.AI_TIMEOUT);
  });

  it('APICallError 413：→ AI_CONTEXT_TOO_LARGE', () => {
    expect(classifyError(createApiError(413, false)).code).toBe(ErrorCode.AI_CONTEXT_TOO_LARGE);
  });

  it('APICallError 400 + context_length_exceeded 文案：→ AI_CONTEXT_TOO_LARGE（供应商主形态）', () => {
    const error = createApiError(400, false);
    // OpenAI/DeepSeek 形态：400 + 错误体带 context_length_exceeded
    Object.assign(error, {
      responseBody: JSON.stringify({
        error: {
          code: 'context_length_exceeded',
          message: "This model's maximum context length is 65536 tokens",
        },
      }),
    });
    const result = classifyError(error);
    expect(result.code).toBe(ErrorCode.AI_CONTEXT_TOO_LARGE);
    expect(result.message).toContain('精简对话');
  });

  it('APICallError 400 + Anthropic prompt is too long 文案：→ AI_CONTEXT_TOO_LARGE', () => {
    const error = createApiError(400, false);
    Object.assign(error, {
      responseBody: JSON.stringify({
        error: { message: 'prompt is too long: 200000 tokens > 180000 maximum' },
      }),
    });
    expect(classifyError(error).code).toBe(ErrorCode.AI_CONTEXT_TOO_LARGE);
  });

  it('APICallError message 含 maximum context length（无 responseBody）：→ AI_CONTEXT_TOO_LARGE', () => {
    const error = new APICallError({
      url: 'https://api.example.com/v1/chat/completions',
      statusCode: 400,
      responseHeaders: {},
      requestBodyValues: {},
      message: '400 This model maximum context length is exceeded',
      isRetryable: false,
    });
    expect(classifyError(error).code).toBe(ErrorCode.AI_CONTEXT_TOO_LARGE);
  });

  it('APICallError 400 无超限文案（普通参数错）：→ AI_MODEL_ERROR（不误判）', () => {
    const error = createApiError(400, false);
    Object.assign(error, {
      responseBody: JSON.stringify({ error: { message: 'Invalid parameter: temperature' } }),
    });
    expect(classifyError(error).code).toBe(ErrorCode.AI_MODEL_ERROR);
  });

  it('APICallError 400 文案含孤词 context window（定价/参数说明类）：不误判', () => {
    const error = createApiError(400, false);
    Object.assign(error, {
      responseBody: JSON.stringify({
        error: { message: 'Invalid parameter: context window size must be positive' },
      }),
    });
    expect(classifyError(error).code).toBe(ErrorCode.AI_MODEL_ERROR);
  });

  it('APICallError 429：→ AI_RATE_LIMITED', () => {
    expect(classifyError(createApiError(429, true)).code).toBe(ErrorCode.AI_RATE_LIMITED);
  });

  it('APICallError 500/502/503：→ AI_MODEL_ERROR', () => {
    expect(classifyError(createApiError(500, false)).code).toBe(ErrorCode.AI_MODEL_ERROR);
    expect(classifyError(createApiError(502, false)).code).toBe(ErrorCode.AI_MODEL_ERROR);
    expect(classifyError(createApiError(503, true)).code).toBe(ErrorCode.AI_MODEL_ERROR);
  });

  it('APICallError retryable（无明确状态码）：→ AI_STREAM_INTERRUPTED', () => {
    expect(classifyError(createApiError(undefined, true)).code).toBe(
      ErrorCode.AI_STREAM_INTERRUPTED,
    );
  });

  it('APICallError 422：→ AI_MODEL_ERROR（请求参数错误）', () => {
    expect(classifyError(createApiError(422, false)).code).toBe(ErrorCode.AI_MODEL_ERROR);
  });

  it('APICallError 其他状态码：→ AI_MODEL_ERROR', () => {
    expect(classifyError(createApiError(418, false)).code).toBe(ErrorCode.AI_MODEL_ERROR);
  });

  it('LoadAPIKeyError：→ AI_API_KEY_MISSING', () => {
    const loadError = new LoadAPIKeyError({ message: 'load failed' });
    const result = classifyError(loadError);
    expect(result.code).toBe(ErrorCode.AI_API_KEY_MISSING);
  });

  it('TypeError：→ AI_STREAM_INTERRUPTED', () => {
    expect(classifyError(new TypeError('fetch failed')).code).toBe(ErrorCode.AI_STREAM_INTERRUPTED);
  });

  it('TimeoutError（AbortSignal.timeout）：→ AI_TIMEOUT', () => {
    const timeoutError = new DOMException('The operation timed out', 'TimeoutError');
    expect(classifyError(timeoutError).code).toBe(ErrorCode.AI_TIMEOUT);
  });

  it('未知错误：→ INTERNAL_ERROR', () => {
    expect(classifyError(new Error('weird')).code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(classifyError('string error').code).toBe(ErrorCode.INTERNAL_ERROR);
  });
});

describe('classifyModelFailure（三轴分类）', () => {
  it('429：rate_limited 三轴齐活 + Retry-After 透传', () => {
    const error = createApiError(429, true);
    Object.assign(error, { responseHeaders: { 'retry-after': '30' } });
    const result = classifyModelFailure(error);
    expect(result.code).toBe(ModelErrorCode.ModelRateLimited);
    expect(result.reason).toBe(ModelFailureReason.Provider);
    expect(result.retryReason).toBe(ModelRetryReason.RateLimited);
    expect(result.retryable).toBe(true);
    expect(result.retryAfterMs).toBe(30_000);
  });

  it('400 + 超限文案：context_exceeded + 不可重试（重试必然再失败）', () => {
    const error = createApiError(400, false);
    Object.assign(error, {
      responseBody: JSON.stringify({ error: { code: 'context_length_exceeded' } }),
    });
    const result = classifyModelFailure(error);
    expect(result.code).toBe(ModelErrorCode.ModelContextExceeded);
    expect(result.retryReason).toBe(ModelRetryReason.NotRetryable);
    expect(result.retryable).toBe(false);
  });

  it('TypeError + cause ECONNRESET：network_error 归因（非 provider——降级路由不看它）', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' }),
    });
    const result = classifyModelFailure(error);
    expect(result.code).toBe(ModelErrorCode.ModelNetworkError);
    expect(result.reason).toBe(ModelFailureReason.NetworkError);
    expect(result.retryReason).toBe(ModelRetryReason.NetworkError);
    expect(result.retryable).toBe(true);
  });

  it('TypeError（编程错误形态）：runtime 归因 + 不可重试（不伪装网络抖动）', () => {
    const result = classifyModelFailure(new TypeError('Cannot read properties of undefined'));
    expect(result.reason).toBe(ModelFailureReason.Runtime);
    expect(result.retryable).toBe(false);
    expect(result.code).toBe(ModelErrorCode.ModelUnknown);
  });

  it('AbortError：cancelled 归因（供应商失败率统计不含取消）', () => {
    const result = classifyModelFailure(new DOMException('aborted', 'AbortError'));
    expect(result.code).toBe(ModelErrorCode.ModelRequestCancelled);
    expect(result.reason).toBe(ModelFailureReason.Cancelled);
    expect(result.retryable).toBe(false);
  });

  it('5xx：server_error 处置（指数退避一档，与限流区分）', () => {
    const result = classifyModelFailure(createApiError(502, false));
    expect(result.retryReason).toBe(ModelRetryReason.ServerError);
    expect(result.retryable).toBe(true);
    expect(result.retryReason).not.toBe(ModelRetryReason.RateLimited);
  });
});
