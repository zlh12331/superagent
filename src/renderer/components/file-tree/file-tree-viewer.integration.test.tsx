import type { FileEntry } from '@code-agent/shared/renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ThemeProvider } from '@/providers/ThemeProvider';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';
import { useFileViewerStore } from '@/stores/transient/file-viewer-store';

import { FileTreePanel } from './FileTreePanel';
import { FileViewerPanel } from './FileViewerPanel';

vi.mock('@/hooks/use-file-tree', () => ({ useFileTree: () => ({ refresh: vi.fn() }) }));

const { getHighlighterMock, ensureLangLoadedMock } = vi.hoisted(() => ({
  getHighlighterMock: vi.fn(),
  ensureLangLoadedMock: vi.fn(),
}));
vi.mock('@/lib/highlight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/highlight')>()),
  getHighlighter: getHighlighterMock,
  ensureLangLoaded: ensureLangLoadedMock,
}));

const ROOT = 'C:\\proj';

/** 构造文件条目（挂在根目录下） */
function entry(name: string): FileEntry {
  return { name, path: `${ROOT}\\${name}`, type: 'file', size: 0, modifiedAt: 0 };
}

/** 同时挂载文件树面板与查看器面板（共享真实 store） */
function renderTreeAndViewer() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ThemeProvider>
        <FileTreePanel workingDir={ROOT} />
        <FileViewerPanel />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

/** 点击树中指定文件节点 */
function clickFile(name: string): void {
  const button = screen.getAllByRole('button').find((b) => b.textContent === name);
  expect(button, `文件节点 ${name} 应已渲染`).toBeDefined();
  fireEvent.click(button as HTMLElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  getHighlighterMock.mockResolvedValue({
    codeToHtml: vi.fn((content: string) => `<pre data-testid="hl">${content}</pre>`),
  });
  ensureLangLoadedMock.mockResolvedValue(undefined);
  window.api.file = {
    list: vi.fn().mockResolvedValue({ data: { entries: [] } }),
    read: vi.fn().mockImplementation(({ path }: { path: string }) =>
      Promise.resolve({
        data: { content: path.endsWith('a.ts') ? 'alpha content' : 'beta content', totalLines: 1 },
      }),
    ),
  } as never;
  useFileTreeStore.getState().reset();
  useFileViewerStore.setState({
    open: false,
    filePath: null,
    editMode: false,
    originalContent: '',
    editedContent: '',
    isDirty: false,
  });
  useFileTreeStore.getState().setRootPath(ROOT);
  useFileTreeStore.getState().setEntries(ROOT, [entry('a.ts'), entry('b.ts')]);
});

describe('文件树 → 查看器 集成链路', () => {
  it('正向：点击树中文件 → 查看器打开并显示内容，树节点进入激活态', async () => {
    const { container } = renderTreeAndViewer();

    clickFile('a.ts');

    await waitFor(() => expect(useFileViewerStore.getState().open).toBe(true));
    await waitFor(() => expect(useFileViewerStore.getState().filePath).toBe(`${ROOT}\\a.ts`));
    await waitFor(() => expect(container.textContent).toContain('alpha content'));
    const activeNode = container.querySelector('.ft-file.active');
    expect(activeNode?.textContent).toContain('a.ts');
  });

  it('正向边界：切换另一文件 → 内容与激活态随之切换', async () => {
    const { container } = renderTreeAndViewer();

    clickFile('a.ts');
    await waitFor(() => expect(container.textContent).toContain('alpha content'));

    clickFile('b.ts');
    await waitFor(() => expect(container.textContent).toContain('beta content'));
    expect(container.textContent).not.toContain('alpha content');
    const activeNode = container.querySelector('.ft-file.active');
    expect(activeNode?.textContent).toContain('b.ts');
    expect(useFileViewerStore.getState().filePath).toBe(`${ROOT}\\b.ts`);
  });

  it('异常：文件读取失败 → 树点击成功，查看器渲染错误态而不崩溃', async () => {
    window.api.file = {
      list: vi.fn().mockResolvedValue({ data: { entries: [] } }),
      read: vi.fn().mockResolvedValue({
        error: { code: 'FS_READ_FAILED', message: 'EACCES: permission denied' },
      }),
    } as never;
    const { container } = renderTreeAndViewer();

    clickFile('a.ts');

    expect(await screen.findByText(i18n.t('common.fileLoadFailed'))).toBeDefined();
    expect(screen.getByText(/EACCES/)).toBeDefined();
    expect(container.querySelector('.ft-file.active')?.textContent).toContain('a.ts');
  });
});
