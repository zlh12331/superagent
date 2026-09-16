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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ThemeProvider } from '@/providers/ThemeProvider';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { useFileViewerStore } from '@/stores/transient/file-viewer-store';

import { FileViewerPanel } from '../FileViewerPanel';

const { getHighlighterMock, ensureLangLoadedMock, writeMock } = vi.hoisted(() => ({
  getHighlighterMock: vi.fn(),
  ensureLangLoadedMock: vi.fn(),
  writeMock: vi.fn(),
}));
// 命令式确认（退出编辑的脏数据保护）用 mock 驱动：DialogHost 不在本测试的渲染树内
const { mockConfirm } = vi.hoisted(() => ({ mockConfirm: vi.fn(async () => true) }));
vi.mock('@/stores/transient/confirm-dialog-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/transient/confirm-dialog-store')>()),
  confirm: mockConfirm,
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

  describe('内容区状态与编辑态（覆盖此前未测分支）', () => {
    it('加载失败：渲染失败提示 + 原始错误消息', async () => {
      window.api.file = {
        ...(window.api.file ?? {}),
        read: vi.fn().mockResolvedValue({
          error: { code: 'FS_READ_FAILED', message: 'EACCES: permission denied' },
        }),
      } as never;
      openViewer('C:\\proj\\src\\a.ts');
      render(createWrapper());

      expect(await screen.findByText(i18n.t('common.fileLoadFailed'))).toBeDefined();
      expect(screen.getByText(/EACCES/)).toBeDefined();
    });

    it('空文件：查看态显示空内容提示', async () => {
      diskContent = '';
      openViewer('C:\\proj\\empty.txt');
      render(createWrapper());

      expect(await screen.findByText(i18n.t('common.emptyFile'))).toBeDefined();
      // 空内容 → 复制按钮禁用
      expect(screen.getByLabelText(i18n.t('fileViewer.copyContent'))).toBeDisabled();
    });

    it('编辑态 + 空内容：渲染可编辑 textarea（空文件必须能写入，不再卡在占位文案）', async () => {
      diskContent = '';
      useFileViewerStore.setState({
        open: true,
        filePath: 'C:\\proj\\empty.txt',
        editMode: true,
        originalContent: '',
        editedContent: '',
        isDirty: false,
      });
      const { container } = render(createWrapper());

      // 新建空文件后进入编辑态：必须有输入面（此前只显示"空文件"占位 → 端到端死路）
      const textarea = await screen.findByLabelText(
        i18n.t('chat.editFileLabel', { name: 'empty.txt' }),
      );
      expect(textarea).toBeDefined();
      // 空内容时给出引导占位（否则 textarea 全空，用户不知可输入）
      expect((textarea as HTMLTextAreaElement).placeholder).toBe(i18n.t('common.emptyFileEdit'));
      expect(container.querySelector('.file-viewer-empty')).toBeNull();
    });

    it('编辑态 + 非空内容：不显示空文件引导占位', async () => {
      diskContent = 'hello';
      useFileViewerStore.setState({
        open: true,
        filePath: 'C:\\proj\\src\\a.ts',
        editMode: true,
        originalContent: 'hello',
        editedContent: 'hello',
        isDirty: false,
      });
      render(createWrapper());

      const textarea = await screen.findByLabelText(i18n.t('chat.editFileLabel', { name: 'a.ts' }));
      expect((textarea as HTMLTextAreaElement).placeholder).toBe('');
    });

    it('编辑态 + 有内容：渲染 textarea，且非 dirty 时保存禁用、复制可用', async () => {
      diskContent = 'hello';
      useFileViewerStore.setState({
        open: true,
        filePath: 'C:\\proj\\src\\a.ts',
        editMode: true,
        originalContent: 'hello',
        editedContent: 'hello',
        isDirty: false,
      });
      const { container } = render(createWrapper());

      expect(await screen.findByText('hello')).toBeDefined();
      expect(container.querySelector('textarea')).not.toBeNull();
      // 非 dirty → 保存按钮禁用（无可保存修改）
      expect(screen.getByLabelText(i18n.t('common.save'))).toBeDisabled();
      // 有内容 → 复制可用
      expect(screen.getByLabelText(i18n.t('fileViewer.copyContent'))).toBeEnabled();
    });

    it('退出编辑（非 dirty）：直接退出，不弹确认', () => {
      useFileViewerStore.setState({
        open: true,
        filePath: 'C:\\proj\\src\\a.ts',
        editMode: true,
        isDirty: false,
      });
      render(createWrapper());

      fireEvent.click(screen.getByLabelText(i18n.t('fileViewer.switchToPreview')));

      expect(mockConfirm).not.toHaveBeenCalled();
      expect(useFileViewerStore.getState().editMode).toBe(false);
    });

    it('退出编辑（脏 + 取消确认）：留在编辑态（不丢弃未保存修改）', async () => {
      useFileViewerStore.setState({
        open: true,
        filePath: 'C:\\proj\\src\\a.ts',
        editMode: true,
        isDirty: true,
        originalContent: 'x',
        editedContent: 'y',
      });
      mockConfirm.mockResolvedValueOnce(false);
      render(createWrapper());

      fireEvent.click(screen.getByLabelText(i18n.t('fileViewer.switchToPreview')));

      await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
      expect(useFileViewerStore.getState().editMode).toBe(true);
    });

    it('退出编辑（脏 + 确认）：退出编辑态', async () => {
      useFileViewerStore.setState({
        open: true,
        filePath: 'C:\\proj\\src\\a.ts',
        editMode: true,
        isDirty: true,
        originalContent: 'x',
        editedContent: 'y',
      });
      mockConfirm.mockResolvedValueOnce(true);
      render(createWrapper());

      fireEvent.click(screen.getByLabelText(i18n.t('fileViewer.switchToPreview')));

      await waitFor(() => expect(useFileViewerStore.getState().editMode).toBe(false));
    });
  });

  describe('工具栏行数（lineCount 语义）', () => {
    it('查看态：优先使用 IPC 返回的 totalLines（磁盘权威值）', async () => {
      window.api.file = {
        ...(window.api.file ?? {}),
        read: vi.fn().mockResolvedValue({ data: { content: 'a\nb', totalLines: 7 } }),
      } as never;
      openViewer('C:\\proj\\src\\a.ts');
      const { container } = render(createWrapper());

      await waitFor(() => expect(useFileViewerStore.getState().originalContent).toBe('a\nb'));
      // 内容仅 2 行但磁盘 totalLines=7（如截断/权威统计）→ 显示 IPC 值
      expect(container.querySelector('.file-viewer-meta')?.textContent).toContain('7');
    });

    it('查看态空文件：行数显示 0（而非 1 行空行）', async () => {
      diskContent = '';
      openViewer('C:\\proj\\empty.txt');
      const { container } = render(createWrapper());

      await screen.findByText(i18n.t('common.emptyFile'));
      expect(container.querySelector('.file-viewer-meta')?.textContent).toContain('0');
    });

    it('编辑态：行数随编辑缓冲实时变化（此前陈旧显示磁盘行数）', async () => {
      useFileViewerStore.setState({
        open: true,
        filePath: 'C:\\proj\\src\\a.ts',
        editMode: true,
        originalContent: 'a\nb\nc',
        editedContent: 'a\nb\nc\nd\ne',
        isDirty: true,
      });
      const { container } = render(createWrapper());

      const metaText = (): string =>
        container.querySelector('.file-viewer-meta')?.textContent ?? '';
      // 编辑缓冲 5 行（磁盘只有 3 行）→ 显示 5
      await waitFor(() => expect(metaText()).toContain('5'));
      // 继续编辑（删到只剩一行）→ 行数同步为 1
      await act(async () => {
        useFileViewerStore.getState().setEditedContent('only');
      });
      await waitFor(() => expect(metaText()).toContain('1'));
    });
  });

  describe('编辑器交互与工具栏动作（补交互链路）', () => {
    /** 为 navigator 注入 clipboard stub（jsdom 无实现），返回 writeText mock 供断言 */
    function stubClipboard(impl: () => Promise<void>): ReturnType<typeof vi.fn> {
      const writeText = vi.fn(impl);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });
      return writeText;
    }

    it('编辑态输入：textarea onChange → editedContent 与 isDirty 实时更新', async () => {
      useFileViewerStore.setState({
        open: true,
        filePath: 'C:\\proj\\src\\a.ts',
        editMode: true,
        originalContent: 'hello',
        editedContent: 'hello',
        isDirty: false,
      });
      render(createWrapper());

      // aria-label = chat.editFileLabel { name: 文件名 }
      const textarea = await screen.findByLabelText(i18n.t('chat.editFileLabel', { name: 'a.ts' }));
      fireEvent.change(textarea, { target: { value: 'typed by user' } });

      expect(useFileViewerStore.getState().editedContent).toBe('typed by user');
      expect(useFileViewerStore.getState().isDirty).toBe(true);
    });

    it('编辑态滚动：textarea 滚动同步到高亮层（scrollTop / scrollLeft）', async () => {
      useFileViewerStore.setState({
        open: true,
        filePath: 'C:\\proj\\src\\a.ts',
        editMode: true,
        originalContent: 'a\nb\nc',
        editedContent: 'a\nb\nc',
        isDirty: false,
      });
      const { container } = render(createWrapper());

      await waitFor(() =>
        expect(container.querySelector('.file-viewer-editor-highlight')).not.toBeNull(),
      );
      const textarea = container.querySelector(
        '.file-viewer-editor-textarea',
      ) as HTMLTextAreaElement;
      const highlight = container.querySelector('.file-viewer-editor-highlight') as HTMLElement;
      textarea.scrollTop = 30;
      textarea.scrollLeft = 5;
      fireEvent.scroll(textarea);

      expect(highlight.scrollTop).toBe(30);
      expect(highlight.scrollLeft).toBe(5);
    });

    it('保存按钮（编辑态 dirty）：点击触发写盘（按钮链路，区别于 Ctrl+S 桥接）', async () => {
      useFileViewerStore.setState({
        open: true,
        filePath: 'C:\\proj\\src\\a.ts',
        editMode: true,
        originalContent: 'old',
        editedContent: 'new content',
        isDirty: true,
      });
      render(createWrapper());

      fireEvent.click(screen.getByLabelText(i18n.t('common.save')));

      await waitFor(() =>
        expect(writeMock).toHaveBeenCalledWith(expect.objectContaining({ content: 'new content' })),
      );
    });

    it('复制按钮：写入剪贴板并进入 copied 反馈态', async () => {
      const writeText = stubClipboard(() => Promise.resolve());
      diskContent = 'hello';
      useFileViewerStore.setState({
        open: true,
        filePath: 'C:\\proj\\src\\a.ts',
        originalContent: 'hello',
      });
      render(createWrapper());

      await waitFor(() => expect(useFileViewerStore.getState().originalContent).toBe('hello'));
      fireEvent.click(screen.getByLabelText(i18n.t('fileViewer.copyContent')));

      await waitFor(() => expect(writeText).toHaveBeenCalledWith('hello'));
      // copied 反馈态：aria-label / 文案切换为「已复制」
      expect(screen.getByLabelText(i18n.t('common.copied'))).toBeDefined();
    });

    it('复制按钮异常：剪贴板写入失败 → toast 错误（不再静默）', async () => {
      stubClipboard(() => Promise.reject(new Error('denied')));
      diskContent = 'hello';
      useFileViewerStore.setState({
        open: true,
        filePath: 'C:\\proj\\src\\a.ts',
        originalContent: 'hello',
      });
      render(createWrapper());

      await waitFor(() => expect(useFileViewerStore.getState().originalContent).toBe('hello'));
      fireEvent.click(screen.getByLabelText(i18n.t('fileViewer.copyContent')));

      await waitFor(() =>
        expect(toastMocks.toast.error).toHaveBeenCalledWith(i18n.t('common.copyFailed')),
      );
    });

    it('高亮异常：codeToHtml 抛错 → 降级纯文本渲染（不崩溃）', async () => {
      getHighlighterMock.mockResolvedValue({
        codeToHtml: vi.fn(() => {
          throw new Error('unsupported lang');
        }),
      });
      diskContent = 'plain text';
      openViewer('C:\\proj\\plain.txt');
      const { container } = render(createWrapper());

      await waitFor(() =>
        expect(container.querySelector('.file-viewer-plaintext')?.textContent).toBe('plain text'),
      );
    });

    it('异常边界：错误非 Error 实例（如字符串）→ String(error) 兜底显示', async () => {
      window.api.file = {
        ...(window.api.file ?? {}),
        // queryFn 直接透传 rejection → error 为非 Error 值
        read: vi.fn().mockRejectedValue('boom plain string'),
      } as never;
      openViewer('C:\\proj\\src\\a.ts');
      render(createWrapper());

      expect(await screen.findByText('boom plain string')).toBeDefined();
      expect(screen.getByText(i18n.t('common.fileLoadFailed'))).toBeDefined();
    });

    it('主题跟随：settings theme=light → shiki 使用 github-light', async () => {
      useSettingsStore.setState({ theme: 'light' });
      const codeToHtml = vi.fn(() => '<pre data-testid="hl">light</pre>');
      getHighlighterMock.mockResolvedValue({ codeToHtml });
      diskContent = 'old content';
      openViewer('C:\\proj\\src\\a.ts');
      render(createWrapper());

      await waitFor(() => expect(codeToHtml).toHaveBeenCalled());
      expect(codeToHtml).toHaveBeenCalledWith('old content', {
        lang: 'typescript',
        theme: 'github-light',
      });
      useSettingsStore.setState({ theme: 'system' });
    });
  });
});
