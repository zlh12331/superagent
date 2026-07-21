// packages/shared/src/__tests__/errors.test.ts
// AppError 与 ErrorCode 单元测试
import { describe, expect, it } from 'vitest';
import { AppError, ERROR_META, ErrorCode } from '../constants/errors';

describe('ErrorCode', () => {
  it('包含所有通用基础设施错误码', () => {
    // 通用
    expect(ErrorCode.UNKNOWN).toBe('UNKNOWN');
    expect(ErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
    expect(ErrorCode.INVALID_INPUT).toBe('INVALID_INPUT');
    expect(ErrorCode.NOT_FOUND).toBe('NOT_FOUND');
    expect(ErrorCode.UNAUTHORIZED).toBe('UNAUTHORIZED');
    expect(ErrorCode.RATE_LIMITED).toBe('RATE_LIMITED');
    // IPC
    expect(ErrorCode.IPC_SENDER_INVALID).toBe('IPC_SENDER_INVALID');
    expect(ErrorCode.IPC_CHANNEL_NOT_FOUND).toBe('IPC_CHANNEL_NOT_FOUND');
    // AI
    expect(ErrorCode.AI_API_KEY_MISSING).toBe('AI_API_KEY_MISSING');
    expect(ErrorCode.AI_RATE_LIMITED).toBe('AI_RATE_LIMITED');
    // 文件系统
    expect(ErrorCode.FS_READ_FAILED).toBe('FS_READ_FAILED');
    expect(ErrorCode.FS_WRITE_FAILED).toBe('FS_WRITE_FAILED');
    expect(ErrorCode.FS_DISK_FULL).toBe('FS_DISK_FULL');
  });

  it('每个错误码都有对应的 ERROR_META 条目', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(ERROR_META[code]).toBeDefined();
      expect(ERROR_META[code].userMessage).toBeTypeOf('string');
      expect(ERROR_META[code].userMessage.length).toBeGreaterThan(0);
      expect(typeof ERROR_META[code].retryable).toBe('boolean');
      expect(ERROR_META[code].severity).toMatch(/info|warn|error|fatal/);
    }
  });
});

describe('AppError', () => {
  it('默认 message 来自 ERROR_META', () => {
    const err = new AppError(ErrorCode.NOT_FOUND);
    expect(err.message).toBe(ERROR_META[ErrorCode.NOT_FOUND].userMessage);
    expect(err.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('自定义 message 优先于 ERROR_META', () => {
    const err = new AppError(ErrorCode.INVALID_INPUT, '字段 name 必填');
    expect(err.message).toBe('字段 name 必填');
  });

  it('toIpcError 返回可序列化结构', () => {
    const err = new AppError(ErrorCode.INVALID_INPUT, '校验失败', undefined, { field: 'name' });
    const ipcErr = err.toIpcError();
    expect(ipcErr).toEqual({
      code: 'INVALID_INPUT',
      message: '校验失败',
      details: { field: 'name' },
    });
  });

  it('retryable 与 severity 来自 ERROR_META', () => {
    const retryable = new AppError(ErrorCode.AI_RATE_LIMITED);
    expect(retryable.retryable).toBe(true);

    const error = new AppError(ErrorCode.INTERNAL_ERROR);
    expect(error.severity).toBe('error');
  });

  it('支持 cause 链', () => {
    const root = new Error('底层错误');
    const err = new AppError(ErrorCode.INTERNAL_ERROR, undefined, root);
    expect(err.cause).toBe(root);
  });
});
