// src/renderer/lib/__tests__/error-actions.test.ts
// error-actions 单测：错误码解析与恢复动作注册表
// 无业务 mock：直接构造 Error 驱动。

import { describe, expect, it } from 'vitest';

import { parseErrorCode, resolveErrorAction } from '../error-actions';

describe('parseErrorCode', () => {
  it('标准格式 "[CODE] message" → 解析出错误码', () => {
    expect(parseErrorCode(new Error('[AI_TIMEOUT] request timeout'))).toBe('AI_TIMEOUT');
  });

  it('无错误码前缀 → undefined', () => {
    expect(parseErrorCode(new Error('plain message'))).toBeUndefined();
  });

  it('非法错误码（未在 ErrorCode 注册）→ undefined', () => {
    expect(parseErrorCode(new Error('[FAKE_CODE] boom'))).toBeUndefined();
  });

  it('空消息 → undefined', () => {
    expect(parseErrorCode(new Error(''))).toBeUndefined();
  });
});

describe('resolveErrorAction', () => {
  it('AI_API_KEY_MISSING → open-settings', () => {
    const action = resolveErrorAction(new Error('[AI_API_KEY_MISSING] no key'));
    expect(action).toEqual({ kind: 'open-settings' });
  });

  it('AI_API_KEY_INVALID → open-settings', () => {
    const action = resolveErrorAction(new Error('[AI_API_KEY_INVALID] bad key'));
    expect(action).toEqual({ kind: 'open-settings' });
  });

  it('未注册错误码 → undefined（使用默认重试）', () => {
    expect(resolveErrorAction(new Error('[FS_READ_FAILED] boom'))).toBeUndefined();
  });

  it('无错误码 → undefined', () => {
    expect(resolveErrorAction(new Error('boom'))).toBeUndefined();
  });
});
