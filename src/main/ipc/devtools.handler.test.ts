// src/main/ipc/devtools.handler.test.ts
// devtools.handler 单测：devtools:open（BrowserWindow 查找 + openDevTools 调用）

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFromWebContents } = vi.hoisted(() => ({
  mockFromWebContents: vi.fn(),
}));

vi.mock('electron', () => ({
  // 字符串键：避免 useNamingConvention 对 PascalCase 属性名的检查
  ['BrowserWindow']: { fromWebContents: mockFromWebContents },
}));

import { devtoolsHandlers } from './devtools.handler';

/** 构造 sender 形状的 ctx（BrowserWindow.fromWebContents 需要 sender） */
function createCtx(win: { webContents: { openDevTools: ReturnType<typeof vi.fn> } } | null) {
  const sender = { id: 1 };
  mockFromWebContents.mockReturnValue(win);
  return { sender, traceId: 'trace-1' } as never;
}

describe('devtools.handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('open（默认 mode）：打开 detach 模式 DevTools', async () => {
    const openDevTools = vi.fn();
    const ctx = createCtx({ webContents: { openDevTools } });
    const result = await devtoolsHandlers.open({ mode: undefined }, ctx);
    expect(openDevTools).toHaveBeenCalledWith({ mode: 'detach' });
    expect(result).toEqual({ ok: true, mode: 'detach' });
  });

  it('open（显式 mode=right）：透传 mode', async () => {
    const openDevTools = vi.fn();
    const ctx = createCtx({ webContents: { openDevTools } });
    const result = await devtoolsHandlers.open({ mode: 'right' }, ctx);
    expect(openDevTools).toHaveBeenCalledWith({ mode: 'right' });
    expect(result).toEqual({ ok: true, mode: 'right' });
  });

  it('sender 窗口不存在：返回 ok=false 不抛错', async () => {
    const ctx = createCtx(null);
    const result = await devtoolsHandlers.open({ mode: undefined }, ctx);
    expect(result).toEqual({ ok: false, mode: 'detach' });
  });
});
