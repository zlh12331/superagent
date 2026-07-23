// src/main/ipc/dialog.handler.test.ts
// dialog.handler 单测：dialog:pickDirectory channel
//
// 测试维度：正向 / 边界 / 异常

import type { OpenDialogReturnValue } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockShowOpenDialog } = vi.hoisted(() => ({
  mockShowOpenDialog: vi.fn(),
}));

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: mockShowOpenDialog,
  },
}));

// 测试 handler 注册表（类型安全，避免 noUncheckedIndexedAccess / unknown 问题）
interface TestHandlerRegistry {
  [channel: string]: ((input: unknown) => Promise<unknown>) | undefined;
}
const testHandlers: TestHandlerRegistry = {};

// mock wrap（避免真实 ipcMain.handle 注册）
vi.mock('../utils/wrap', () => ({
  wrap: vi.fn(
    (channel: string, _schema: unknown, handler: (input: unknown) => Promise<unknown>) => {
      testHandlers[channel] = handler;
    },
  ),
}));

import { registerDialogHandlers } from './dialog.handler';

/**
 * 取出 dialog:pickDirectory handler，若未注册则显式抛错。
 *
 * 避免使用非空断言 `handler!`（biome lint/style/noNonNullAssertion），
 * 同时保证 handler 为 undefined 时测试有明确的失败原因，而非静默通过。
 */
function getPickDirHandler(): (input: unknown) => Promise<unknown> {
  const handler = testHandlers['dialog:pickDirectory'];
  if (handler === undefined) {
    throw new Error('dialog:pickDirectory handler not registered');
  }
  return handler;
}

describe('dialog.handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerDialogHandlers();
  });

  it('正向：showOpenDialog 返回选中路径 → 返回 { canceled: false, path }', async () => {
    mockShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['D:\\selected'],
    } as OpenDialogReturnValue);

    const result = await getPickDirHandler()({});
    expect(result).toEqual({ canceled: false, path: 'D:\\selected' });
  });

  it('边界：showOpenDialog 返回多选(理论不应发生) → 取 filePaths[0]', async () => {
    mockShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['D:\\a', 'D:\\b'],
    } as OpenDialogReturnValue);

    const result = await getPickDirHandler()({});
    expect(result).toEqual({ canceled: false, path: 'D:\\a' });
  });

  it('异常：用户取消 → 返回 { canceled: true, path: undefined }', async () => {
    mockShowOpenDialog.mockResolvedValue({
      canceled: true,
      filePaths: [],
    } as OpenDialogReturnValue);

    const result = await getPickDirHandler()({});
    expect(result).toEqual({ canceled: true });
    expect((result as { path?: string }).path).toBeUndefined();
  });

  it('异常：canceled=false 但 filePaths 为空(兜底) → 返回 { canceled: true }', async () => {
    mockShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [],
    } as OpenDialogReturnValue);

    const result = await getPickDirHandler()({});
    expect(result).toEqual({ canceled: true });
  });
});
