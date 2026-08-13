// src/renderer/stores/transient/file-viewer-store.test.ts
// 文件查看器 store 补测：全局保存桥接 + 切换文件脏数据保护

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { confirm } from '@/stores/transient/confirm-dialog-store';
import { useFileViewerStore } from '@/stores/transient/file-viewer-store';

// 仅 mock confirm（弹窗 UI 由 DialogHost 渲染，store 层只关心 Promise 结果）
vi.mock('@/stores/transient/confirm-dialog-store', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/stores/transient/confirm-dialog-store')>();
  return { ...mod, confirm: vi.fn() };
});

const confirmMock = vi.mocked(confirm);

describe('file-viewer-store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFileViewerStore.setState({
      open: false,
      filePath: null,
      editMode: false,
      originalContent: '',
      editedContent: '',
      isDirty: false,
    });
    useFileViewerStore.getState().registerSaveHandler(null);
  });

  describe('全局保存桥接（Ctrl+S）', () => {
    it('无注册处理器：requestSave no-op', () => {
      expect(() => useFileViewerStore.getState().requestSave()).not.toThrow();
    });

    it('注册后 requestSave 触发处理器；注销后 no-op', () => {
      const handler = vi.fn();
      useFileViewerStore.getState().registerSaveHandler(handler);
      useFileViewerStore.getState().requestSave();
      expect(handler).toHaveBeenCalledTimes(1);

      useFileViewerStore.getState().registerSaveHandler(null);
      useFileViewerStore.getState().requestSave();
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('切换文件脏数据保护', () => {
    it('无脏数据：直接切换并重置编辑态', async () => {
      useFileViewerStore.getState().setLoadedContent('old');
      await useFileViewerStore.getState().openFile('C:\\new.ts');
      const s = useFileViewerStore.getState();
      expect(confirmMock).not.toHaveBeenCalled();
      expect(s.filePath).toBe('C:\\new.ts');
      expect(s.open).toBe(true);
      expect(s.isDirty).toBe(false);
      expect(s.editMode).toBe(false);
    });

    it('有脏数据 + 用户取消：保持当前文件与编辑内容', async () => {
      await useFileViewerStore.getState().openFile('C:\\a.ts');
      useFileViewerStore.getState().setLoadedContent('original');
      useFileViewerStore.getState().setEditedContent('edited-draft');
      confirmMock.mockResolvedValueOnce(false);

      await useFileViewerStore.getState().openFile('C:\\other.ts');

      const s = useFileViewerStore.getState();
      expect(s.filePath).toBe('C:\\a.ts');
      expect(s.open).toBe(true);
      expect(s.isDirty).toBe(true);
      expect(s.editedContent).toBe('edited-draft');
    });

    it('有脏数据 + 用户确认：切换并丢弃修改', async () => {
      await useFileViewerStore.getState().openFile('C:\\a.ts');
      useFileViewerStore.getState().setLoadedContent('original');
      useFileViewerStore.getState().setEditedContent('edited-draft');
      confirmMock.mockResolvedValueOnce(true);

      await useFileViewerStore.getState().openFile('C:\\other.ts');

      const s = useFileViewerStore.getState();
      expect(s.filePath).toBe('C:\\other.ts');
      expect(s.isDirty).toBe(false);
      expect(s.editedContent).toBe('');
    });

    it('重复打开同一文件：不弹确认', async () => {
      await useFileViewerStore.getState().openFile('C:\\same.ts');
      useFileViewerStore.getState().setLoadedContent('content');
      useFileViewerStore.getState().setEditedContent('draft');
      await useFileViewerStore.getState().openFile('C:\\same.ts');
      expect(confirmMock).not.toHaveBeenCalled();
    });
  });
});
