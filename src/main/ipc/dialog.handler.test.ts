// src/main/ipc/dialog.handler.test.ts
// dialog.handler 单测（定义表驱动模式下直接测 handler 对象）
//
// 测试维度：正向 / 边界 / 异常
//
// 说明：handler 是纯业务函数（channel/schema 由定义表 + wrap 统一处理），
// 测试直接调用 dialogHandlers.pickDirectory/pickFiles(input, ctx)，ctx 传入空对象即可。
//
// pickFiles 额外覆盖「用户手势授权」登记：对话框返回的选中路径必须进 user-grants，
// 否则工作区收口后 file:read 会拒绝读取用户自己选的附件（可用性回归）。

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenDialogReturnValue } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockShowOpenDialog } = vi.hoisted(() => ({
  mockShowOpenDialog: vi.fn(),
}));

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: mockShowOpenDialog,
  },
}));

import { clearUserReadGrants, matchUserGrantedReadPath } from '../infra/file/user-grants';
import { dialogHandlers } from './dialog.handler';

/** 空 ctx（两个方法都不使用 ctx） */
const EMPTY_CTX = {} as never;

describe('dialog.handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearUserReadGrants();
  });

  afterEach(() => {
    clearUserReadGrants();
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

  describe('pickFiles（附件选择 + 用户手势授权登记）', () => {
    let dir: string;
    let fileA: string;
    let fileB: string;

    beforeEach(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), 'code-agent-dialog-')));
      fileA = join(dir, 'a.txt');
      fileB = join(dir, 'b.txt');
      writeFileSync(fileA, 'a', 'utf8');
      writeFileSync(fileB, 'b', 'utf8');
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('multiple=true：使用 openFile + multiSelections', async () => {
      mockShowOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: [fileA, fileB],
      } as OpenDialogReturnValue);

      const result = await dialogHandlers.pickFiles({ multiple: true }, EMPTY_CTX);
      expect(mockShowOpenDialog).toHaveBeenCalledWith({
        properties: ['openFile', 'multiSelections'],
      });
      expect(result).toEqual({ canceled: false, paths: [fileA, fileB] });
    });

    it('multiple=false：仅 openFile 单选', async () => {
      mockShowOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: [fileA],
      } as OpenDialogReturnValue);

      await dialogHandlers.pickFiles({ multiple: false }, EMPTY_CTX);
      expect(mockShowOpenDialog).toHaveBeenCalledWith({ properties: ['openFile'] });
    });

    it('选中路径登记为用户手势授权（file:read 才放行得到）', async () => {
      mockShowOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: [fileA, fileB],
      } as OpenDialogReturnValue);

      await dialogHandlers.pickFiles({ multiple: true }, EMPTY_CTX);
      expect(matchUserGrantedReadPath(fileA)).toBe(fileA);
      expect(matchUserGrantedReadPath(fileB)).toBe(fileB);
    });

    it('取消选择：不登记任何授权', async () => {
      mockShowOpenDialog.mockResolvedValue({
        canceled: true,
        filePaths: [],
      } as OpenDialogReturnValue);

      const result = await dialogHandlers.pickFiles({ multiple: true }, EMPTY_CTX);
      expect(result).toEqual({ canceled: true });
      expect(matchUserGrantedReadPath(fileA)).toBeNull();
    });

    it('目录选择（pickDirectory）不登记文件授权：只放开到文件粒度', async () => {
      mockShowOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: [dir],
      } as OpenDialogReturnValue);

      await dialogHandlers.pickDirectory({}, EMPTY_CTX);
      expect(matchUserGrantedReadPath(fileA)).toBeNull();
    });
  });
});
