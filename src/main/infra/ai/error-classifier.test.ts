// src/main/infra/ai/error-classifier.test.ts
// error-classifier 单测：AI 错误分类映射
//
// 测试要点：
// 1. AppError 直接透传
// 2. APICallError 按 statusCode 映射（401/403→KEY_INVALID, 404→MODEL_ERROR, 408→TIMEOUT,
//    413→CONTEXT_TOO_LARGE, 429→RATE_LIMITED, 5xx→MODEL_ERROR, retryable→INTERRUPTED）
// 3. LoadAPIKeyError → AI_API_KEY_MISSING
// 4. TypeError → AI_STREAM_INTERRUPTED
// 5. 未知错误 → INTERNAL_ERROR
// 6. isAbortError 判断

import { AppError, ErrorCode } from '@code-agent/shared';
import { APICallError, LoadAPIKeyError } from 'ai';
import { describe, expect, it } from 'vitest';
import { classifyError, isAbortError } from './error-classifier';

/** 构造 APICallError（AI SDK 类型，仅需 statusCode/isRetryable 字段） */
function createApiError(statusCode: number | undefined, isRetryable: boolean): APICallError {
  return new APICallError({
    url: 'https://api.example.com/v1/chat/completions',
    // exactOptionalPropertyTypes: statusCode 为 undefined 时不传该字段
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

  it('APICallError 404：→ AI_MODEL_ERROR', () => {
    expect(classifyError(createApiError(404, false)).code).toBe(ErrorCode.AI_MODEL_ERROR);
  });

  it('APICallError 408：→ AI_TIMEOUT', () => {
    expect(classifyError(createApiError(408, false)).code).toBe(ErrorCode.AI_TIMEOUT);
  });

  it('APICallError 413：→ AI_CONTEXT_TOO_LARGE', () => {
    expect(classifyError(createApiError(413, false)).code).toBe(ErrorCode.AI_CONTEXT_TOO_LARGE);
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

  it('APICallError 其他状态码：→ AI_MODEL_ERROR', () => {
    expect(classifyError(createApiError(422, false)).code).toBe(ErrorCode.AI_MODEL_ERROR);
  });

  it('LoadAPIKeyError：→ AI_API_KEY_MISSING', () => {
    // LoadAPIKeyError 构造器仅接受 { message }（AI SDK 定义）
    const loadError = new LoadAPIKeyError({ message: 'load failed' });
    const result = classifyError(loadError);
    expect(result.code).toBe(ErrorCode.AI_API_KEY_MISSING);
  });

  it('TypeError：→ AI_STREAM_INTERRUPTED', () => {
    expect(classifyError(new TypeError('fetch failed')).code).toBe(ErrorCode.AI_STREAM_INTERRUPTED);
  });

  it('未知错误：→ INTERNAL_ERROR', () => {
    expect(classifyError(new Error('weird')).code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(classifyError('string error').code).toBe(ErrorCode.INTERNAL_ERROR);
  });
});
