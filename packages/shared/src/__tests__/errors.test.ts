// errors.test.ts：ErrorCode / ERROR_META / AppError 的单元测试——码值稳定、元数据全覆盖、IPC 序列化形态
import { describe, expect, it } from 'vitest';
import { AppError, ERROR_META, ErrorCode } from '../constants/errors';

describe('ErrorCode', () => {
  it('包含所有通用基础设施错误码', () => {
    // 码值即跨进程契约：IpcError.code 原样过 IPC，渲染层再拼成 i18n key（errors.<code>）——
    // 字符串被改不会报错，只会静默退回兜底文案，所以在这里逐个钉死
    expect(ErrorCode.UNKNOWN).toBe('UNKNOWN');
    expect(ErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
    expect(ErrorCode.INVALID_INPUT).toBe('INVALID_INPUT');
    expect(ErrorCode.NOT_FOUND).toBe('NOT_FOUND');
    expect(ErrorCode.UNAUTHORIZED).toBe('UNAUTHORIZED');
    expect(ErrorCode.RATE_LIMITED).toBe('RATE_LIMITED');
    expect(ErrorCode.IPC_SENDER_INVALID).toBe('IPC_SENDER_INVALID');
    expect(ErrorCode.IPC_CHANNEL_NOT_FOUND).toBe('IPC_CHANNEL_NOT_FOUND');
    expect(ErrorCode.AI_API_KEY_MISSING).toBe('AI_API_KEY_MISSING');
    expect(ErrorCode.AI_RATE_LIMITED).toBe('AI_RATE_LIMITED');
    expect(ErrorCode.FS_READ_FAILED).toBe('FS_READ_FAILED');
    expect(ErrorCode.FS_WRITE_FAILED).toBe('FS_WRITE_FAILED');
    expect(ErrorCode.FS_DISK_FULL).toBe('FS_DISK_FULL');
  });

  it('每个错误码都有对应的 ERROR_META 条目', () => {
    // 遍历枚举而非逐个列举：新增错误码自动纳入校验；空 userMessage（占位漏填）编译期查不出来
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
    // details 在第 4 参，只想传它时必须用 undefined 占住第 3 参 cause
    const err = new AppError(ErrorCode.INVALID_INPUT, '校验失败', undefined, { field: 'name' });
    const ipcErr = err.toIpcError();
    // 全等断言：IPC 结构只有契约三键，多带字段即为契约破坏（cause 有意不外传，可能不可序列化）
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
    // 复用 ES2022 原生 Error.cause（errors.ts 经 super 第二参传入），不是自建字段
    const root = new Error('底层错误');
    const err = new AppError(ErrorCode.INTERNAL_ERROR, undefined, root);
    expect(err.cause).toBe(root);
  });
});
