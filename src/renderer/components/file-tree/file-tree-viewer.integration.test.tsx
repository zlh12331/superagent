// src/renderer/components/$1/file-tree-viewer.integration.test.tsx
// 文件树 → 查看器 跨面板集成测试（正向 / 边界 / 异常）
// ──────────────────────────────────────────────────────────────
// 覆盖此前无测试的真实链路：FileTreePanel 渲染根节点 → 点击文件 →
// FileNode 激活 + onOpenFile → file-viewer-store.openFile（切换右面板 tab）→
// FileViewerPanel 经 useFileContent 拉取并展示内容 → 树节点高亮激活态。
//
// mock 边界（单元/集成分层原则）：
// - useFileTree（IPC + watch 数据生命周期）由 hooks 层测试覆盖，此处注入空实现
// - shiki（重依赖 wasm/语言包）替换为透传 codeToHtml，其余导出保留真实实现
// - window.api（Electron 桥）按路径返回假内容 / 错误信封
// store、FileTreeNode、FileViewerPanel、useFileContent 均走真实实现。
// ──────────────────────────────────────────────────────────────

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

// useFileTree（IPC + watch 数据生命周期）由 hooks 层测试覆盖：此处注入空实现，
// 但需保留 refresh 控制面（FileTreePanel 依赖其返回值解构）
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
  // useFileTree 已 mock：根目录与条目由 store 直接注入（对齐组件测试的分层策略）
  useFileTreeStore.getState().setRootPath(ROOT);
  useFileTreeStore.getState().setEntries(ROOT, [entry('a.ts'), entry('b.ts')]);
});

describe('文件树 → 查看器 集成链路', () => {
  it('正向：点击树中文件 → 查看器打开并显示内容，树节点进入激活态', async () => {
    const { container } = renderTreeAndViewer();

    clickFile('a.ts');

    await waitFor(() => expect(useFileViewerStore.getState().open).toBe(true));
    await waitFor(() => expect(useFileViewerStore.getState().filePath).toBe(`${ROOT}\\a.ts`));
    // shiki 透传 mock：查看器正文出现文件内容
    await waitFor(() => expect(container.textContent).toContain('alpha content'));
    // 树节点激活（aria-selected + active 类）
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
    // 树侧激活态已建立（点击链路本身成功，失败仅发生在内容拉取）
    expect(container.querySelector('.ft-file.active')?.textContent).toContain('a.ts');
  });
});
