// src/main/utils/retry.test.ts
// retry 工具单测

import { AppError, ErrorCode } from '@novel-writer/shared';
import { describe, expect, it, vi } from 'vitest';
import { isRetryableError, retry } from './retry';

describe('isRetryableError', () => {
  it('retryable=true 的 AppError 返回 true', () => {
    const err = new AppError(ErrorCode.AI_RATE_LIMITED);
    expect(isRetryableError(err)).toBe(true);
  });

  it('retryable=false 的 AppError 返回 false', () => {
    const err = new AppError(ErrorCode.INVALID_INPUT);
    expect(isRetryableError(err)).toBe(false);
  });

  it('非 AppError 返回 false', () => {
    const err = new Error('普通错误');
    expect(isRetryableError(err)).toBe(false);
  });
});

describe('retry', () => {
  it('成功时直接返回结果，不重试', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await retry(fn, { maxAttempts: 3, baseDelay: 10 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('重试后成功返回结果', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new AppError(ErrorCode.AI_RATE_LIMITED))
      .mockRejectedValueOnce(new AppError(ErrorCode.AI_TIMEOUT))
      .mockResolvedValueOnce('success');

    const result = await retry(fn, { maxAttempts: 3, baseDelay: 10 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('非 retryable 错误立即抛出，不重试', async () => {
    const fn = vi.fn().mockRejectedValue(new AppError(ErrorCode.INVALID_INPUT));
    await expect(retry(fn, { maxAttempts: 3, baseDelay: 10 })).rejects.toThrow(AppError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('达到最大重试次数后抛出最后一个错误', async () => {
    const fn = vi.fn().mockRejectedValue(new AppError(ErrorCode.AI_RATE_LIMITED));
    await expect(retry(fn, { maxAttempts: 2, baseDelay: 10 })).rejects.toThrow(AppError);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('baseDelay * 2^(attempt-1) 指数退避', async () => {
    const sleepSpy = vi.spyOn(globalThis, 'setTimeout');

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new AppError(ErrorCode.AI_RATE_LIMITED))
      .mockResolvedValueOnce('success');

    await retry(fn, { maxAttempts: 2, baseDelay: 100 });

    // 第一次重试等待 baseDelay * 2^0 + 抖动 = 100 + 抖动
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    // noUncheckedIndexedAccess: true 下 calls[0] 与 [1] 可能为 undefined，需显式守卫
    const firstCall = sleepSpy.mock.calls[0];
    if (!firstCall) {
      throw new Error('setTimeout 未被调用');
    }
    const delay = firstCall[1];
    if (delay === undefined) {
      throw new Error('setTimeout 延迟参数缺失');
    }
    expect(delay).toBeGreaterThanOrEqual(100);
    expect(delay).toBeLessThan(700); // 100 + 500 抖动上限

    sleepSpy.mockRestore();
  });

  it('非 AppError 错误立即抛出', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('普通错误'));
    await expect(retry(fn, { maxAttempts: 3, baseDelay: 10 })).rejects.toThrow('普通错误');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
