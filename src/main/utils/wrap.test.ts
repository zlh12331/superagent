// src/main/utils/wrap.test.ts
// wrap IPC handler 包装器单测
// 设计文档 §4.7（IPC sender 校验 + traceId 贯穿）、§7.4（错误处理流程）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Vitest 4 的 vi.mock 会被 hoist，工厂函数内不能引用外部 const
// 必须用 vi.hoisted 导出 mock 对象
const { mockFromWebContents, mockIpcMainHandle } = vi.hoisted(() => ({
  mockFromWebContents: vi.fn(),
  mockIpcMainHandle: vi.fn(),
}));

// mock @sentry/electron/main（避免真实上报）
vi.mock('@sentry/electron/main', () => ({
  captureException: vi.fn(),
}));

// mock electron：仅暴露 wrap 依赖的 ipcMain.handle 与 BrowserWindow.fromWebContents
vi.mock('electron', () => ({
  ipcMain: {
    handle: mockIpcMainHandle,
  },
  // biome-ignore lint/style/useNamingConvention: mock electron BrowserWindow API，需匹配 SDK 原名
  BrowserWindow: {
    fromWebContents: mockFromWebContents,
  },
}));

// mock logger（避免触发真实 electron-log 初始化）
vi.mock('./logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { AppError, ErrorCode } from '@novel-writer/shared';
import * as Sentry from '@sentry/electron/main';
import { ipcMain } from 'electron';
import { wrap } from './wrap';

/**
 * 内部 handler 类型：放宽 event 类型以方便测试构造 mockEvent
 *
 * 真实类型为 (event: IpcMainInvokeEvent, ...args: any[]) => any
 * 测试只需 event.sender 字段，故放宽为 { sender: unknown }
 */
type InternalHandler = (
  event: { sender: unknown },
  input: unknown,
  traceId?: string,
) => Promise<unknown>;

/**
 * 从 ipcMain.handle 调用记录中取出注册的 handler
 *
 * noUncheckedIndexedAccess: true 下 calls[0] 可能为 undefined，需显式守卫
 */
function getRegisteredHandler(): InternalHandler {
  const firstCall = vi.mocked(ipcMain.handle).mock.calls[0];
  if (!firstCall) {
    throw new Error('ipcMain.handle 未被调用');
  }
  return firstCall[1] as unknown as InternalHandler;
}

describe('wrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('成功时返回 { data }', async () => {
    const mockWin = { id: 1 };
    mockFromWebContents.mockReturnValue(mockWin);

    const schema = z.object({ name: z.string() });
    const handler = vi.fn().mockResolvedValue({ id: 1, name: 'test' });

    wrap('test:channel', schema, handler);

    // 获取 ipcMain.handle 注册的回调
    const registeredHandler = getRegisteredHandler();

    // 模拟 IPC 调用：渲染层传入 { name } 与 traceId
    const mockEvent = { sender: {} };
    const result = await registeredHandler(mockEvent, { name: 'test' }, 'trace-123');

    expect(result).toEqual({ data: { id: 1, name: 'test' } });
    expect(handler).toHaveBeenCalledWith(
      { name: 'test' },
      expect.objectContaining({ traceId: 'trace-123' }),
    );
  });

  it('参数校验失败返回 { error }', async () => {
    const mockWin = { id: 1 };
    mockFromWebContents.mockReturnValue(mockWin);

    const schema = z.object({ name: z.string().min(1) });
    const handler = vi.fn();

    wrap('test:channel', schema, handler);

    const registeredHandler = getRegisteredHandler();
    const mockEvent = { sender: {} };
    const result = await registeredHandler(mockEvent, { name: '' }, 'trace-456');

    expect(result).toHaveProperty('error');
    expect(result).toHaveProperty(['error', 'code']);
    expect(result).toHaveProperty(['error', 'message']);
    expect(handler).not.toHaveBeenCalled();
  });

  it('sender 无效返回 { error }', async () => {
    mockFromWebContents.mockReturnValue(null);

    const schema = z.object({ name: z.string() });
    const handler = vi.fn();

    wrap('test:channel', schema, handler);

    const registeredHandler = getRegisteredHandler();
    const mockEvent = { sender: {} };
    const result = await registeredHandler(mockEvent, { name: 'test' }, undefined);

    expect(result).toHaveProperty('error');
    const error = (result as { error: { code: string } }).error;
    expect(error.code).toBe(ErrorCode.IPC_SENDER_INVALID);
    expect(handler).not.toHaveBeenCalled();
  });

  it('handler 抛出 AppError 返回 { error }', async () => {
    const mockWin = { id: 1 };
    mockFromWebContents.mockReturnValue(mockWin);

    const schema = z.object({ name: z.string() });
    const handler = vi.fn().mockRejectedValue(new AppError(ErrorCode.NOT_FOUND));

    wrap('test:channel', schema, handler);

    const registeredHandler = getRegisteredHandler();
    const mockEvent = { sender: {} };
    const result = await registeredHandler(mockEvent, { name: 'test' }, undefined);

    expect(result).toHaveProperty('error');
    const error = (result as { error: { code: string } }).error;
    expect(error.code).toBe(ErrorCode.NOT_FOUND);
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('handler 抛出普通 Error 包装为 INTERNAL_ERROR', async () => {
    const mockWin = { id: 1 };
    mockFromWebContents.mockReturnValue(mockWin);

    const schema = z.object({ name: z.string() });
    const handler = vi.fn().mockRejectedValue(new Error('普通错误'));

    wrap('test:channel', schema, handler);

    const registeredHandler = getRegisteredHandler();
    const mockEvent = { sender: {} };
    const result = await registeredHandler(mockEvent, { name: 'test' }, undefined);

    expect(result).toHaveProperty('error');
    const error = (result as { error: { code: string } }).error;
    expect(error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('无 traceId 时自动生成', async () => {
    const mockWin = { id: 1 };
    mockFromWebContents.mockReturnValue(mockWin);

    const schema = z.object({ name: z.string() });
    const handler = vi.fn().mockResolvedValue('ok');

    wrap('test:channel', schema, handler);

    const registeredHandler = getRegisteredHandler();
    const mockEvent = { sender: {} };
    await registeredHandler(mockEvent, { name: 'test' }, undefined);

    // handler 的第二参数 ctx 应包含自动生成的 traceId
    const ctx = handler.mock.calls[0]?.[1] as { traceId: string } | undefined;
    if (!ctx) {
      throw new Error('handler 未被调用或 ctx 缺失');
    }
    expect(ctx.traceId).toBeDefined();
    expect(typeof ctx.traceId).toBe('string');
    expect(ctx.traceId.length).toBeGreaterThan(0);
  });
});
