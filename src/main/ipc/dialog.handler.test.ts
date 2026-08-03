// src/main/ipc/dialog.handler.test.ts
// dialog.handler 单测：dialog:pickDirectory 方法（定义表驱动模式下直接测 handler 对象）
//
// 测试维度：正向 / 边界 / 异常
//
// 说明：handler 是纯业务函数（channel/schema 由定义表 + wrap 统一处理），
// 测试直接调用 dialogHandlers.pickDirectory(input, ctx)，ctx 传入空对象即可。

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

import { dialogHandlers } from './dialog.handler';

/** 空 ctx（pickDirectory 不使用 ctx） */
const EMPTY_CTX = {} as never;

describe('dialog.handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('正向：showOpenDialog 返回选中路径 → 返回 { canceled: false, path }', async () => {
    mockShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['D:\\selected'],
    } as OpenDialogReturnValue);

    const result = await dialogHandlers.pickDirectory({}, EMPTY_CTX);
    expect(result).toEqual({ canceled: false, path: 'D:\\selected' });
  });

  it('边界：showOpenDialog 返回多选(理论不应发生) → 取 filePaths[0]', async () => {
    mockShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['D:\\a', 'D:\\b'],
    } as OpenDialogReturnValue);

    const result = await dialogHandlers.pickDirectory({}, EMPTY_CTX);
    expect(result).toEqual({ canceled: false, path: 'D:\\a' });
  });

  it('异常：用户取消 → 返回 { canceled: true, path: undefined }', async () => {
    mockShowOpenDialog.mockResolvedValue({
      canceled: true,
      filePaths: [],
    } as OpenDialogReturnValue);

    const result = await dialogHandlers.pickDirectory({}, EMPTY_CTX);
    expect(result).toEqual({ canceled: true });
    expect((result as { path?: string }).path).toBeUndefined();
  });

  it('异常：canceled=false 但 filePaths 为空(兜底) → 返回 { canceled: true }', async () => {
    mockShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [],
    } as OpenDialogReturnValue);

    const result = await dialogHandlers.pickDirectory({}, EMPTY_CTX);
    expect(result).toEqual({ canceled: true });
  });
});
