// src/main/ipc/terminal.handler.test.ts
// terminal.handler 单测：4 个方法（fake TerminalService DI 注入）
// + cwd 真实性校验（P2 加固：不存在的 cwd 转类型化错误，而不是裸 spawn 失败）
// + 集成终端不被路径收口（合法 cwd = 任意真实目录，含工作区外）

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    terminalService = createFakeTerminalService();
    handlers = createTerminalHandlers({ terminalService });
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'code-agent-th-')));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('create：转发参数与 sender', async () => {
    const ctx = { sender: { id: 5 }, traceId: 't' } as never;
    const result = await handlers.create(
      { cwd: tempDir, command: undefined, env: undefined, cols: 80, rows: 24 },
      ctx,
    );
    expect(terminalService.create).toHaveBeenCalledWith({
      cwd: tempDir,
      command: undefined,
      env: undefined,
      cols: 80,
      rows: 24,
      webContents: { id: 5 },
    });
    expect(result.terminalId).toBe('t1');
  });

  it('create：任意真实目录（非工作区）均可用——集成终端不被路径收口', async () => {
    const outsideWorkspace = realpathSync(mkdtempSync(join(tmpdir(), 'code-agent-th-out-')));
    try {
      await expect(
        handlers.create(
          { cwd: outsideWorkspace, command: 'pwd', env: undefined, cols: 80, rows: 24 },
          {} as never,
        ),
      ).resolves.toMatchObject({ terminalId: 't1' });
    } finally {
      rmSync(outsideWorkspace, { recursive: true, force: true });
    }
  });

  it('create：cwd 未指定 → service 入参不携带 cwd 键（由 service 兜底用户主目录）', async () => {
    await handlers.create(
      { cwd: undefined, command: undefined, env: undefined, cols: 80, rows: 24 },
      {} as never,
    );
    const callArg = vi.mocked(terminalService.create).mock.calls[0]?.[0];
    expect(callArg).toBeDefined();
    expect(callArg !== undefined && 'cwd' in callArg).toBe(false);
  });

  it('create：cwd 不存在 → AppError NOT_FOUND，不触碰 TerminalService', async () => {
    const missing = join(tempDir, 'nope');
    await expect(
      handlers.create(
        { cwd: missing, command: undefined, env: undefined, cols: 80, rows: 24 },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    expect(terminalService.create).not.toHaveBeenCalled();
  });

  it('create：cwd 是文件而非目录 → AppError INVALID_INPUT', async () => {
    const filePath = join(tempDir, 'a.txt');
    writeFileSync(filePath, 'x', 'utf8');
    const error = await handlers
      .create(
        { cwd: filePath, command: undefined, env: undefined, cols: 80, rows: 24 },
        {} as never,
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: ErrorCode.INVALID_INPUT });
    expect(terminalService.create).not.toHaveBeenCalled();
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
