// src/main/ipc/app.handler.test.ts
// app.handler 单测：app 域 handler 对象（定义表驱动模式下直接测业务函数）
//
// 测试维度：正向 / 安全（协议白名单）

import { shell } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
}));

import { AppError, ErrorCode } from '@code-agent/shared/main';

import { appHandlers } from './app.handler';

/** 空 ctx（app 域不使用 ctx） */
const EMPTY_CTX = {} as never;

describe('app.handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getStatus：返回 ready=true', async () => {
    const result = await appHandlers.getStatus(undefined, EMPTY_CTX);
    expect(result).toEqual({ ready: true });
  });

  it('openExternal（http）：调用 shell.openExternal 并返回 ok', async () => {
    const result = await appHandlers.openExternal({ url: 'https://example.com' }, EMPTY_CTX);
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com');
    expect(result).toEqual({ ok: true });
  });

  it('openExternal（https）：允许', async () => {
    await appHandlers.openExternal({ url: 'https://deepseek.com' }, EMPTY_CTX);
    expect(shell.openExternal).toHaveBeenCalledWith('https://deepseek.com');
  });

  it('openExternal（javascript 协议）：拒绝并抛 INVALID_INPUT', async () => {
    await expect(
      appHandlers.openExternal({ url: 'javascript:alert(1)' }, EMPTY_CTX),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_INPUT });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('openExternal（file 协议）：拒绝并抛 INVALID_INPUT', async () => {
    await expect(
      appHandlers.openExternal({ url: 'file:///etc/passwd' }, EMPTY_CTX),
    ).rejects.toThrow(AppError);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});
