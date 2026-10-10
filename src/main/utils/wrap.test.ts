import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { mockFromWebContents, mockIpcMainHandle, mockReportError } = vi.hoisted(() => ({
  mockFromWebContents: vi.fn(),
  mockIpcMainHandle: vi.fn(),
  mockReportError: vi.fn(),
}));

vi.mock('./error-report', () => ({
  reportError: mockReportError,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: mockIpcMainHandle,
  },
  // biome-ignore lint/style/useNamingConvention: mock electron BrowserWindow API，需匹配 SDK 原名
  BrowserWindow: {
    fromWebContents: mockFromWebContents,
  },
}));

vi.mock('./logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { AppError, ErrorCode } from '@code-agent/shared/main';
import { ipcMain } from 'electron';
import { wrap } from './wrap';

type InternalHandler = (
  event: { sender: unknown },
  input: unknown,
  traceId?: string,
) => Promise<unknown>;

function getRegisteredHandler(): InternalHandler {
  const firstCall = vi.mocked(ipcMain.handle).mock.calls[0];
  if (!firstCall) {
    throw new Error('ipcMain.handle 未被调用');
  }
  return firstCall[1] as unknown as InternalHandler;
}

const allowedSender = {
  getURL: () => 'file:///C:/app/out/renderer/index.html',
};

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

    const registeredHandler = getRegisteredHandler();

    const mockEvent = { sender: allowedSender };
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
    const mockEvent = { sender: allowedSender };
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
    const mockEvent = { sender: allowedSender };
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
    const mockEvent = { sender: allowedSender };
    const result = await registeredHandler(mockEvent, { name: 'test' }, undefined);

    expect(result).toHaveProperty('error');
    const error = (result as { error: { code: string } }).error;
    expect(error.code).toBe(ErrorCode.NOT_FOUND);
    expect(mockReportError).toHaveBeenCalled();
  });

  it('handler 抛出普通 Error 包装为 INTERNAL_ERROR', async () => {
    const mockWin = { id: 1 };
    mockFromWebContents.mockReturnValue(mockWin);

    const schema = z.object({ name: z.string() });
    const handler = vi.fn().mockRejectedValue(new Error('普通错误'));

    wrap('test:channel', schema, handler);

    const registeredHandler = getRegisteredHandler();
    const mockEvent = { sender: allowedSender };
    const result = await registeredHandler(mockEvent, { name: 'test' }, undefined);

    expect(result).toHaveProperty('error');
    const error = (result as { error: { code: string } }).error;
    expect(error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(mockReportError).toHaveBeenCalled();
  });

  it('无 traceId 时自动生成', async () => {
    const mockWin = { id: 1 };
    mockFromWebContents.mockReturnValue(mockWin);

    const schema = z.object({ name: z.string() });
    const handler = vi.fn().mockResolvedValue('ok');

    wrap('test:channel', schema, handler);

    const registeredHandler = getRegisteredHandler();
    const mockEvent = { sender: allowedSender };
    await registeredHandler(mockEvent, { name: 'test' }, undefined);

    const ctx = handler.mock.calls[0]?.[1] as { traceId: string } | undefined;
    if (!ctx) {
      throw new Error('handler 未被调用或 ctx 缺失');
    }
    expect(ctx.traceId).toBeDefined();
    expect(typeof ctx.traceId).toBe('string');
    expect(ctx.traceId.length).toBeGreaterThan(0);
  });

  it('响应契约校验：结构合法时正常返回 { data }', async () => {
    const mockWin = { id: 1 };
    mockFromWebContents.mockReturnValue(mockWin);

    const resSchema = z.object({ sessionId: z.string().min(1) });
    const handler = vi.fn().mockResolvedValue({ sessionId: 'session-1' });

    wrap('test:channel', null, handler, resSchema);

    const registeredHandler = getRegisteredHandler();
    const result = await registeredHandler({ sender: allowedSender }, undefined, undefined);

    expect(result).toEqual({ data: { sessionId: 'session-1' } });
  });

  it('响应契约校验：结构不符返回 INVALID_RESPONSE（防手写 Res 接口漂移）', async () => {
    const mockWin = { id: 1 };
    mockFromWebContents.mockReturnValue(mockWin);

    const resSchema = z.object({ sessionId: z.string().min(1) });
    const handler = vi.fn().mockResolvedValue({ ok: true });

    wrap('test:channel', null, handler, resSchema);

    const registeredHandler = getRegisteredHandler();
    const result = await registeredHandler({ sender: allowedSender }, undefined, undefined);

    expect(result).toHaveProperty('error');
    const error = (result as { error: { code: string } }).error;
    expect(error.code).toBe(ErrorCode.INVALID_RESPONSE);
  });

  it('P0 收口：schema 未声明字段被 strip（边界生效，不只检查）', async () => {
    const mockWin = { id: 1 };
    mockFromWebContents.mockReturnValue(mockWin);

    const resSchema = z.object({
      config: z.object({ name: z.string() }),
    });
    const handler = vi.fn().mockResolvedValue({
      config: {
        name: 'fs',
        headers: Object.fromEntries([['Authorization', 'Bearer secret']]),
        env: Object.fromEntries([['KEY', 'v']]),
      },
    });

    wrap('test:channel', null, handler, resSchema);

    const registeredHandler = getRegisteredHandler();
    const result = (await registeredHandler({ sender: allowedSender }, undefined, undefined)) as {
      data: { config: Record<string, unknown> };
    };

    expect(result.data.config).toEqual({ name: 'fs' });
    expect(result.data.config).not.toHaveProperty('headers');
    expect(result.data.config).not.toHaveProperty('env');
  });

  it('无 resSchema 时 handler 返回原样透传（不引入裁剪行为）', async () => {
    const mockWin = { id: 1 };
    mockFromWebContents.mockReturnValue(mockWin);

    const handler = vi.fn().mockResolvedValue({ anything: true, extra: [1, 2] });

    wrap('test:channel', null, handler);

    const registeredHandler = getRegisteredHandler();
    const result = (await registeredHandler({ sender: allowedSender }, undefined, undefined)) as {
      data: unknown;
    };

    expect(result.data).toEqual({ anything: true, extra: [1, 2] });
  });

  it('P2 加固：非法外部 traceId 被丢弃并替换为生成的 UUID', async () => {
    const mockWin = { id: 1 };
    mockFromWebContents.mockReturnValue(mockWin);

    const schema = z.object({ name: z.string() });
    const handler = vi.fn().mockResolvedValue({ ok: true });

    wrap('test:channel', schema, handler);

    const registeredHandler = getRegisteredHandler();
    await registeredHandler({ sender: allowedSender }, { name: 'x' }, 'bad id\\nINJECTED');

    const ctx = handler.mock.calls[0]?.[1] as { traceId: string } | undefined;
    if (!ctx) {
      throw new Error('handler 未被调用或 ctx 缺失');
    }
    expect(ctx.traceId).not.toContain('bad id');
    expect(ctx.traceId).toMatch(/^[\w-]{8,64}$/);
  });

  it('P2 加固：非白名单来源 URL 返回 IPC_SENDER_INVALID', async () => {
    const mockWin = { id: 1 };
    mockFromWebContents.mockReturnValue(mockWin);

    const schema = z.object({ name: z.string() });
    const handler = vi.fn();

    wrap('test:channel', schema, handler);

    const registeredHandler = getRegisteredHandler();
    const evilSender = { getURL: () => 'https://evil.example.com/payload' };
    const result = await registeredHandler({ sender: evilSender }, { name: 'x' }, undefined);

    expect(handler).not.toHaveBeenCalled();
    const error = (result as { error: { code: string } }).error;
    expect(error.code).toBe(ErrorCode.IPC_SENDER_INVALID);
  });

  it('P2 加固：null schema 时收到非 undefined 入参返回 INVALID_INPUT', async () => {
    const mockWin = { id: 1 };
    mockFromWebContents.mockReturnValue(mockWin);

    const handler = vi.fn().mockResolvedValue({ ok: true });

    wrap('test:channel', null, handler);

    const registeredHandler = getRegisteredHandler();
    const result = await registeredHandler({ sender: allowedSender }, { sneaky: true }, undefined);

    expect(handler).not.toHaveBeenCalled();
    const error = (result as { error: { code: string } }).error;
    expect(error.code).toBe(ErrorCode.INVALID_INPUT);
  });
});
