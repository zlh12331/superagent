// src/main/ipc/app.handler.test.ts
// app.handler 单测：app 域 handler 对象（定义表驱动模式下直接测业务函数）
//
// 测试维度：正向 / 安全（协议白名单）/ 诊断导出（保存与取消双路径）

import { dialog, shell } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user-data'),
  },
  dialog: { showSaveDialog: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));

vi.mock('../diagnostics', () => ({
  exportDiagnosticsPackage: vi.fn(),
}));

import { AppError, ErrorCode, IPC_PROTOCOL_VERSION } from '@code-agent/shared/main';

import { exportDiagnosticsPackage } from '../diagnostics';
import { appHandlers } from './app.handler';

/** 空 ctx（app 域不使用 ctx） */
const EMPTY_CTX = {} as never;

/** mock 的导出函数（类型收窄用） */
const mockExport = vi.mocked(exportDiagnosticsPackage);

describe('app.handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getStatus：返回 ready=true 与当前协议版本', async () => {
    const result = await appHandlers.getStatus(undefined, EMPTY_CTX);
    expect(result).toEqual({ ready: true, protocolVersion: IPC_PROTOCOL_VERSION });
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

  it('openDataDir：调用 shell.openPath 打开 userData', async () => {
    vi.mocked(shell.openPath).mockResolvedValue('');
    const result = await appHandlers.openDataDir(undefined, EMPTY_CTX);
    expect(shell.openPath).toHaveBeenCalledWith('/mock/user-data');
    expect(result).toEqual({ ok: true });
  });

  it('exportDiagnostics（确认保存）：打包到所选路径并返回 saved=true', async () => {
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({
      canceled: false,
      filePath: 'C:/diag/diagnostics-2026-09-04.zip',
    });
    mockExport.mockResolvedValue(undefined);

    const result = await appHandlers.exportDiagnostics(undefined, EMPTY_CTX);

    expect(mockExport).toHaveBeenCalledWith({
      filePath: 'C:/diag/diagnostics-2026-09-04.zip',
      userDataPath: '/mock/user-data',
    });
    expect(result).toEqual({ saved: true, path: 'C:/diag/diagnostics-2026-09-04.zip' });
  });

  it('exportDiagnostics（用户取消）：不打包并返回 saved=false', async () => {
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true, filePath: '' });

    const result = await appHandlers.exportDiagnostics(undefined, EMPTY_CTX);

    expect(mockExport).not.toHaveBeenCalled();
    expect(result).toEqual({ saved: false });
  });

  it('exportDiagnostics（打包失败）：向上抛错（wrap 统一错误分类）', async () => {
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({
      canceled: false,
      filePath: 'C:/diag/diagnostics.zip',
    });
    mockExport.mockRejectedValue(new Error('zip write failed'));

    await expect(appHandlers.exportDiagnostics(undefined, EMPTY_CTX)).rejects.toThrow(
      'zip write failed',
    );
  });
});
