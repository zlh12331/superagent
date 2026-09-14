// src/renderer/components/file-tree/__tests__/FileViewerPanel.test.tsx
// 文件查看面板单测（2026-09-12 补覆盖：此前 0 测试，cx 46 全项目现存第二高）
//
// 测试要点（聚焦易回归的行为）：
// 1. 未打开 → 渲染引导空态
// 2. 数据到达 → 内容同步进 store（originalContent/editedContent）
// 3. **脏数据保护**：data 后台刷新但 isDirty → 不覆盖用户未保存编辑（关键守卫）
// 4. 超长内容（>5000 行）→ 跳过 shiki 高亮（性能降级）
// 5. 保存：requestSave 桥接 → 真实 useFileWrite（含缓存失效）→ isDirty 复位
//
// mock 策略：只 mock shiki（重依赖）与 api 层（file.read/write）——
// useFileContent / useFileWrite 走真实实现，使「保存 → 缓存失效 → 回读」的
// 完整链路进入测试（此前若 mock 掉 use-file-write 会连失效行为一起 mock 掉）。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '@/providers/ThemeProvider';
import { useFileViewerStore } from '@/stores/transient/file-viewer-store';

import { FileViewerPanel } from '../FileViewerPanel';

const { getHighlighterMock, ensureLangLoadedMock, writeMock } = vi.hoisted(() => ({
  getHighlighterMock: vi.fn(),
  ensureLangLoadedMock: vi.fn(),
  writeMock: vi.fn(),
}));
// shiki 高亮是重依赖（wasm/语言包），单测替换 getHighlighter/ensureLangLoaded；
// 其余导出（normalizeLang 等纯函数）保留真实实现——file-viewer-utils 也依赖本模块
vi.mock('@/lib/highlight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/highlight')>()),
  getHighlighter: getHighlighterMock,
  ensureLangLoaded: ensureLangLoadedMock,
}));

const toastMocks = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: toastMocks.toast }));

/** 模拟磁盘内容：read 返回它，write 修改它（使「保存→失效→回读」链路可断言） */
let diskContent = 'old content';

function createWrapper(): ReactElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <FileViewerPanel />
      </ThemeProvider>
    </QueryClientProvider>
  );
}

/** 打开面板（组件经 useFileContent 拉取内容） */
function openViewer(path: string): void {
  useFileViewerStore.setState({
    open: true,
    filePath: path,
    editMode: false,
    originalContent: '',
    editedContent: '',
    isDirty: false,
  });
}

describe('FileViewerPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    diskContent = 'old content';
    getHighlighterMock.mockResolvedValue({
      codeToHtml: vi.fn(() => '<pre data-testid="hl">highlighted</pre>'),
    });
    ensureLangLoadedMock.mockResolvedValue(undefined);
    writeMock.mockImplementation((input: { content: string }) => {
      diskContent = input.content;
      return Promise.resolve({ data: { bytesWritten: input.content.length } });
    });
    window.api.file = {
      ...(window.api.file ?? {}),
      read: vi.fn().mockImplementation(() => Promise.resolve({ data: { content: diskContent } })),
      write: writeMock,
    } as never;
    useFileViewerStore.setState({
      open: false,
      filePath: null,
      editMode: false,
      originalContent: '',
      editedContent: '',
      isDirty: false,
    });
  });

  describe('渲染门控', () => {
    it('open=false：渲染未选择文件的空态（不加载内容）', () => {
      const { container } = render(createWrapper());
      // 组件在 open=false 时渲染引导空态（非 null——Dialog 宿主常驻）
      expect(container.textContent).toContain('从文件树选择文件');
      expect(getHighlighterMock).not.toHaveBeenCalled();
    });

    it('open=true：渲染面板并加载数据进 store', async () => {
      openViewer('C:\\proj\\src\\a.ts');
      const { container } = render(createWrapper());

      await waitFor(() =>
        expect(useFileViewerStore.getState().originalContent).toBe('old content'),
      );
      // 同步进编辑缓冲（进入编辑态时的起点）
      expect(useFileViewerStore.getState().editedContent).toBe('old content');
      expect(container.innerHTML).not.toBe('');
    });
  });

  describe('脏数据保护（关键守卫）', () => {
    it('data 后台刷新但 isDirty → 不覆盖用户未保存编辑', async () => {
      // 用户已编辑（dirty）；挂载后 useQuery 拉到磁盘内容，但守卫应跳过同步
      useFileViewerStore.setState({
        open: true,
        filePath: 'C:\\proj\\src\\a.ts',
        isDirty: true,
        originalContent: 'user edit',
        editedContent: 'user edit',
      });
      render(createWrapper());

      await waitFor(() => expect(useFileViewerStore.getState().originalContent).toBe('user edit'));
      expect(useFileViewerStore.getState().editedContent).toBe('user edit');
    });
  });

  describe('高亮降级', () => {
    it('超长内容（>5000 行）：跳过 shiki 高亮', async () => {
      diskContent = Array.from({ length: 5001 }, (_, i) => `line ${i}`).join('\n');
      openViewer('C:\\proj\\big.txt');
      render(createWrapper());

      await waitFor(() => expect(useFileViewerStore.getState().originalContent).toBe(diskContent));
      // 内容就位后，shiki 不应被触碰（降级为纯文本渲染）
      expect(getHighlighterMock).not.toHaveBeenCalled();
    });

    it('常规内容：调用 shiki 并按语言加载', async () => {
      openViewer('C:\\proj\\src\\a.ts');
      render(createWrapper());

      await waitFor(() => expect(getHighlighterMock).toHaveBeenCalled());
      expect(ensureLangLoadedMock).toHaveBeenCalled();
    });
  });

  describe('保存链路（真实 useFileWrite：写盘 + 缓存失效回读）', () => {
    it('requestSave：携带编辑内容写盘并复位 dirty', async () => {
      useFileViewerStore.setState({
        open: true,
        filePath: 'C:\\proj\\src\\a.ts',
        editMode: true,
        originalContent: 'old content',
        editedContent: 'edited content',
        isDirty: true,
      });
      render(createWrapper());

      // Ctrl+S 桥接：全局快捷键 → requestSave → 注册的 handleSave
      await act(async () => {
        useFileViewerStore.getState().requestSave();
      });

      await waitFor(() => expect(writeMock).toHaveBeenCalledTimes(1));
      expect(writeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'C:\\proj\\src\\a.ts',
          content: 'edited content',
          append: false,
          createDirs: false,
        }),
      );
      // markSaved：dirty 复位
      expect(useFileViewerStore.getState().isDirty).toBe(false);
      expect(toastMocks.toast.success).toHaveBeenCalled();
    });

    it('保存后缓存失效：回读磁盘新内容（真实失效链）', async () => {
      useFileViewerStore.setState({
        open: true,
        filePath: 'C:\\proj\\src\\a.ts',
        editMode: true,
        originalContent: 'old content',
        editedContent: 'edited content',
        isDirty: true,
      });
      render(createWrapper());

      await act(async () => {
        useFileViewerStore.getState().requestSave();
      });

      // useFileWrite onSuccess 失效 ['file', path] → 重新 read → 磁盘已是新内容
      await waitFor(() =>
        expect(useFileViewerStore.getState().originalContent).toBe('edited content'),
      );
      expect(useFileViewerStore.getState().editedContent).toBe('edited content');
    });

    it('非 dirty 时 requestSave：不触发写入（守卫）', async () => {
      useFileViewerStore.setState({
        open: true,
        filePath: 'C:\\proj\\src\\a.ts',
        editMode: true,
        isDirty: false,
      });
      render(createWrapper());

      await act(async () => {
        useFileViewerStore.getState().requestSave();
      });

      expect(writeMock).not.toHaveBeenCalled();
    });
  });
});
