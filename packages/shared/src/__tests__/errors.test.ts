// packages/shared/src/__tests__/errors.test.ts
// AppError 与 ErrorCode 单元测试
import { describe, expect, it } from 'vitest';
import { AppError, ERROR_META, ErrorCode } from '../constants/errors';

describe('ErrorCode', () => {
  it('包含所有设计文档 §7.2 规定的错误码', () => {
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
    // 项目
    expect(ErrorCode.PROJECT_NOT_FOUND).toBe('PROJECT_NOT_FOUND');
    expect(ErrorCode.PROJECT_NAME_EXISTS).toBe('PROJECT_NAME_EXISTS');
    // AI
    expect(ErrorCode.AI_API_KEY_MISSING).toBe('AI_API_KEY_MISSING');
    expect(ErrorCode.AI_RATE_LIMITED).toBe('AI_RATE_LIMITED');
    // RAG
    expect(ErrorCode.RAG_EMBEDDING_FAILED).toBe('RAG_EMBEDDING_FAILED');
    // PG
    expect(ErrorCode.PG_CRASHED).toBe('PG_CRASHED');
    // Ollama
    expect(ErrorCode.OLLAMA_NOT_INSTALLED).toBe('OLLAMA_NOT_INSTALLED');
    expect(ErrorCode.OLLAMA_MODEL_NOT_FOUND).toBe('OLLAMA_MODEL_NOT_FOUND');
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
    const err = new AppError(ErrorCode.PROJECT_NOT_FOUND);
    expect(err.message).toBe(ERROR_META[ErrorCode.PROJECT_NOT_FOUND].userMessage);
    expect(err.code).toBe(ErrorCode.PROJECT_NOT_FOUND);
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

    const fatal = new AppError(ErrorCode.PG_CRASHED);
    expect(fatal.severity).toBe('error');
  });

  it('支持 cause 链', () => {
    const root = new Error('PostgreSQL 进程退出码 1');
    const err = new AppError(ErrorCode.PG_CRASHED, undefined, root);
    expect(err.cause).toBe(root);
  });
});
