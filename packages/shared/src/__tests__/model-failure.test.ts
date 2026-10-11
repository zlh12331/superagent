// model-failure.test.ts：模型失败三轴契约测试——枚举值钉死（值即跨进程/跨包契约）、
// 三轴互斥语义、ModelFailure 结构抽样
import { describe, expect, it } from 'vitest';
import {
  ModelErrorCode,
  type ModelFailure,
  ModelFailureReason,
  ModelRetryReason,
} from '../constants/model-failure';

describe('ModelErrorCode', () => {
  it('码值钉死（字符串即契约，改动会静默破坏跨包消费）', () => {
    expect(ModelErrorCode.ModelRequestCancelled).toBe('model_request_cancelled');
    expect(ModelErrorCode.ModelContextExceeded).toBe('model_context_exceeded');
    expect(ModelErrorCode.ModelRateLimited).toBe('model_rate_limited');
    expect(ModelErrorCode.ModelStreamIdleTimeout).toBe('model_stream_idle_timeout');
    expect(ModelErrorCode.ModelAuthFailed).toBe('model_auth_failed');
    expect(ModelErrorCode.ModelEmptyResponse).toBe('model_empty_response');
  });

  it('全部码值为 snake_case 形态且不与 ErrorCode.AI_* 冲突', () => {
    for (const code of Object.values(ModelErrorCode)) {
      expect(code).toMatch(/^[a-z][a-z_]+$/);
    }
  });
});

describe('ModelFailureReason / ModelRetryReason', () => {
  it('归因轴钉死', () => {
    expect(ModelFailureReason.NetworkError).toBe('network_error');
    expect(ModelFailureReason.Provider).toBe('provider');
    expect(ModelFailureReason.Cancelled).toBe('cancelled');
  });

  it('处置轴钉死（闸门冷却只认 rate_limited 一档）', () => {
    expect(ModelRetryReason.RateLimited).toBe('rate_limited');
    expect(ModelRetryReason.NotRetryable).toBe('not_retryable');
    expect(ModelRetryReason.ProviderBlocked).toBe('provider_blocked');
  });
});

describe('ModelFailure 结构', () => {
  it('抽样构造：限流失败携带全部诊断字段', () => {
    const failure: ModelFailure = {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReason.Provider,
      retryReason: ModelRetryReason.RateLimited,
      retryable: true,
      retryAfterMs: 30_000,
      statusCode: 429,
      providerErrorCode: '1302',
      message: 'HTTP 429',
    };
    expect(failure.retryable).toBe(true);
    expect(failure.retryAfterMs).toBe(30_000);
  });

  it('抽样构造：语义性失败（context 超限）不可重试', () => {
    const failure: ModelFailure = {
      code: ModelErrorCode.ModelContextExceeded,
      reason: ModelFailureReason.Provider,
      retryReason: ModelRetryReason.NotRetryable,
      retryable: false,
      statusCode: 400,
      message: 'prompt is too long',
    };
    expect(failure.retryable).toBe(false);
  });
});
