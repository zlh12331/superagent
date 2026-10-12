import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';

import { useFileTreeOps } from './use-file-tree-ops';

const { mockToastError } = vi.hoisted(() => ({ mockToastError: vi.fn() }));
vi.mock('sonner', () => ({
  toast: { error: mockToastError, success: vi.fn(), warning: vi.fn() },
}));

const PARENT = '/proj/src';

function setupApi() {
  const create = vi.fn().mockResolvedValue({ data: { path: `${PARENT}/new.ts` } });
  const createDir = vi.fn().mockResolvedValue({ data: { path: `${PARENT}/newdir` } });
  window.api.file = { create, createDir } as never;
  return { create, createDir };
}

beforeEach(() => {
  vi.clearAllMocks();
  useFileTreeStore.getState().reset();
});

describe('useFileTreeOps', () => {
  describe('createFile', () => {
    it('正向：按契约调用 file:create（createDirs=false）并返回 true', async () => {
      const { create } = setupApi();
      const { result } = renderHook(() => useFileTreeOps());

      const ok = await result.current.createFile(PARENT, 'new.ts');

      expect(ok).toBe(true);
      expect(create).toHaveBeenCalledWith({ path: `${PARENT}/new.ts`, createDirs: false });
    });

    it('正向：成功后取消内联新建态（输入框收起，依赖 watch 刷新父目录）', async () => {
      setupApi();
      useFileTreeStore.getState().startCreate(PARENT, 'file');
      const { result } = renderHook(() => useFileTreeOps());

      await result.current.createFile(PARENT, 'new.ts');

      expect(useFileTreeStore.getState().creatingEntry).toBeNull();
    });

    it('正向：在途期间父目录被标记 pending（状态可抵达已渲染的行），完成后清除', async () => {
      let resolveCreate!: (value: unknown) => void;
      window.api.file = {
        create: vi.fn(
          () =>
            new Promise((resolve) => {
              resolveCreate = resolve;
            }),
        ),
      } as never;
      const { result } = renderHook(() => useFileTreeOps());

      const pending = result.current.createFile(PARENT, 'new.ts');

      expect(useFileTreeStore.getState().pendingDirs.has(PARENT)).toBe(true);

      resolveCreate({ data: { path: `${PARENT}/new.ts` } });
      await pending;

      expect(useFileTreeStore.getState().pendingDirs.has(PARENT)).toBe(false);
    });

    it('异常：IPC 错误信封 → 返回 false + toast 提示（不吞错）', async () => {
      window.api.file = {
        create: vi
          .fn()
          .mockResolvedValue({ error: { code: 'FS_WRITE_FAILED', message: 'EACCES' } }),
      } as never;
      const { result } = renderHook(() => useFileTreeOps());

      const ok = await result.current.createFile(PARENT, 'new.ts');

      expect(ok).toBe(false);
      expect(mockToastError).toHaveBeenCalledWith(
        i18n.t('common.createFileFailed'),
        expect.objectContaining({ description: expect.stringContaining('EACCES') }),
      );
    });

    it('异常：IPC 异常（reject）→ 返回 false + 提示，且 pending 仍被复位', async () => {
      window.api.file = { create: vi.fn().mockRejectedValue(new Error('ipc down')) } as never;
      const { result } = renderHook(() => useFileTreeOps());

      const ok = await result.current.createFile(PARENT, 'new.ts');

      expect(ok).toBe(false);
      expect(mockToastError).toHaveBeenCalled();
      expect(useFileTreeStore.getState().pendingDirs.has(PARENT)).toBe(false);
    });

    it('异常：失败时保留内联新建态（用户可改名重试，不被静默丢弃）', async () => {
      window.api.file = { create: vi.fn().mockRejectedValue(new Error('boom')) } as never;
      useFileTreeStore.getState().startCreate(PARENT, 'file');
      const { result } = renderHook(() => useFileTreeOps());

      await result.current.createFile(PARENT, 'new.ts');

      expect(useFileTreeStore.getState().creatingEntry).toEqual({
        parentDir: PARENT,
        type: 'file',
      });
    });

    it('边界：错误值非 Error 实例（字符串）→ String() 兜底进 description', async () => {
      window.api.file = { create: vi.fn().mockRejectedValue('plain failure') } as never;
      const { result } = renderHook(() => useFileTreeOps());

      await result.current.createFile(PARENT, 'new.ts');

      expect(mockToastError).toHaveBeenCalledWith(
        i18n.t('common.createFileFailed'),
        expect.objectContaining({ description: 'plain failure' }),
      );
    });
  });

  describe('createDir', () => {
    it('正向：按契约调用 file:createDir 并返回 true', async () => {
      const { createDir } = setupApi();
      const { result } = renderHook(() => useFileTreeOps());

      const ok = await result.current.createDir(PARENT, 'newdir');

      expect(ok).toBe(true);
      expect(createDir).toHaveBeenCalledWith({ path: `${PARENT}/newdir` });
    });

    it('正向：成功后取消内联新建态', async () => {
      setupApi();
      useFileTreeStore.getState().startCreate(PARENT, 'directory');
      const { result } = renderHook(() => useFileTreeOps());

      await result.current.createDir(PARENT, 'newdir');

      expect(useFileTreeStore.getState().creatingEntry).toBeNull();
    });

    it('异常：失败 → 返回 false + 目录专用错误文案', async () => {
      window.api.file = { createDir: vi.fn().mockRejectedValue(new Error('EACCES')) } as never;
      const { result } = renderHook(() => useFileTreeOps());

      const ok = await result.current.createDir(PARENT, 'newdir');

      expect(ok).toBe(false);
      expect(mockToastError).toHaveBeenCalledWith(
        i18n.t('common.createDirFailed'),
        expect.objectContaining({ description: expect.stringContaining('EACCES') }),
      );
    });

    it('边界：路径拼接复用 joinPath（父目录带尾分隔符不产生双分隔符）', async () => {
      const { createDir } = setupApi();
      const { result } = renderHook(() => useFileTreeOps());

      await result.current.createDir('/proj/src/', 'newdir');

      expect(createDir).toHaveBeenCalledWith({ path: '/proj/src/newdir' });
    });
  });
});
