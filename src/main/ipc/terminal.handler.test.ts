// src/main/ipc/terminal.handler.test.ts
// terminal.handler 单测：4 个方法（fake TerminalService DI 注入）

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminalHandlers, type TerminalHandlerDeps } from './terminal.handler';

/** 创建 fake TerminalService */
function createFakeTerminalService() {
  return {
    create: vi.fn(async () => ({ terminalId: 't1', ok: true })),
    input: vi.fn(async () => ({ ok: true })),
    resize: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(async () => ({ ok: true })),
  } as unknown as TerminalHandlerDeps['terminalService'];
}

describe('terminal.handler', () => {
  let terminalService: ReturnType<typeof createFakeTerminalService>;
  let handlers: ReturnType<typeof createTerminalHandlers>;

  beforeEach(() => {
    vi.clearAllMocks();
    terminalService = createFakeTerminalService();
    handlers = createTerminalHandlers({ terminalService });
  });

  it('create：转发参数与 sender', async () => {
    const ctx = { sender: { id: 5 }, traceId: 't' } as never;
    const result = await handlers.create(
      { cwd: '/tmp', command: undefined, env: undefined, cols: 80, rows: 24 },
      ctx,
    );
    expect(terminalService.create).toHaveBeenCalledWith({
      cwd: '/tmp',
      command: undefined,
      env: undefined,
      cols: 80,
      rows: 24,
      webContents: { id: 5 },
    });
    expect(result.terminalId).toBe('t1');
  });

  it('input：转发 terminalId/data', async () => {
    await handlers.input({ terminalId: 't1', data: 'ls\n' }, {} as never);
    expect(terminalService.input).toHaveBeenCalledWith('t1', 'ls\n');
  });

  it('resize：转发 cols/rows', async () => {
    await handlers.resize({ terminalId: 't1', cols: 100, rows: 30 }, {} as never);
    expect(terminalService.resize).toHaveBeenCalledWith('t1', 100, 30);
  });

  it('kill：转发 terminalId', async () => {
    await handlers.kill({ terminalId: 't1' }, {} as never);
    expect(terminalService.kill).toHaveBeenCalledWith('t1');
  });
});
