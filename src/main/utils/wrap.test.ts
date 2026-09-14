// src/main/utils/wrap.test.ts
// wrap IPC handler 包装器单测
// 设计文档 §4.7（IPC sender 校验 + traceId 贯穿）、§7.4（错误处理流程）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Vitest 4 的 vi.mock 会被 hoist，工厂函数内不能引用外部 const
// 必须用 vi.hoisted 导出 mock 对象
const { mockFromWebContents, mockIpcMainHandle, mockReportError } = vi.hoisted(() => ({
  mockFromWebContents: vi.fn(),
  mockIpcMainHandle: vi.fn(),
  mockReportError: vi.fn(),
}));

// mock 错误上报统一出口（避免真实落盘；断言上报被调用）
vi.mock('./error-report', () => ({
  reportError: mockReportError,
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

import { AppError, ErrorCode } from '@code-agent/shared/main';
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

/**
 * 合法来源 sender mock：prod 入口页 URL 命中 isAllowedSenderUrl 白名单
 * （P2 加固后 wrap 会校验 evt.sender.url()）
 */
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

    // 获取 ipcMain.handle 注册的回调
    const registeredHandler = getRegisteredHandler();

    // 模拟 IPC 调用：渲染层传入 { name } 与 traceId
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

    // handler 的第二参数 ctx 应包含自动生成的 traceId
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
    // handler 返回漂移结构（缺 sessionId）
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

    // 模拟 mcp:list 场景：handler 返回含 headers/env 的 config，
    // resSchema 只声明 name——未声明字段必须被裁剪，不得原样过界。
    // 头部键经 Object.fromEntries 构造（真实 HTTP 头是 Pascal 形态，
    // 字面量会被 useNamingConvention 拦截，语义不变）
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

  // ── P2 加固回归：traceId 形状 / sender 白名单 / null-schema 严格分支 ──

  it('P2 加固：非法外部 traceId 被丢弃并替换为生成的 UUID', async () => {
    const mockWin = { id: 1 };
    mockFromWebContents.mockReturnValue(mockWin);

    const schema = z.object({ name: z.string() });
    const handler = vi.fn().mockResolvedValue({ ok: true });

    wrap('test:channel', schema, handler);

    const registeredHandler = getRegisteredHandler();
    // 换行注入 / 超长 / 空白 均不合法
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
