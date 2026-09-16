// src/renderer/components/file-tree/__tests__/FileTreePanel.test.tsx
// 文件树面板单测（正向 / 边界 / 异常）
// ──────────────────────────────────────────────────────────────
// 覆盖：无工作目录空态、rootPath 未就绪占位、就绪态的树语义与根节点名、
// 返回按钮、菜单三项动作（新建目录/文件/刷新）以及新建确认向 ops 的分流。
//
// 分层（2026-09 file-tree 审计后）：
// - 数据生命周期（IPC + watch + refresh 失败提示）由 use-file-tree 的 hook 测试覆盖
//   → 本文件 mock useFileTree 返回可控的 refresh spy
// - 落盘动作（createFile / createDir）由 use-file-tree-ops 测试覆盖
//   → 本文件 mock useFileTreeOps，只断言「组件把意图转发给了正确的方法」
// - 状态直接由 store 注入（rootPath / expandedPaths / creatingEntry）
// ──────────────────────────────────────────────────────────────

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';
import { useUiStore } from '@/stores/transient/ui-store';

import { FileTreePanel } from '../FileTreePanel';

const { mockRefresh, mockCreateFile, mockCreateDir } = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  mockCreateFile: vi.fn(),
  mockCreateDir: vi.fn(),
}));

// 数据生命周期（IPC + watch + refresh 实现）单独由 hooks 测试覆盖
vi.mock('@/hooks/use-file-tree', () => ({ useFileTree: () => ({ refresh: mockRefresh }) }));
// 落盘动作单独由 hooks 测试覆盖：此处只验证意图转发
vi.mock('@/hooks/use-file-tree-ops', () => ({
  useFileTreeOps: () => ({ createFile: mockCreateFile, createDir: mockCreateDir }),
}));

const ROOT = 'C:\\proj';

/** 渲染面板并等待就绪（rootPath 已同步） */
function renderReady(): void {
  useFileTreeStore.getState().setRootPath(ROOT);
  render(<FileTreePanel workingDir={ROOT} />);
}

/** 就绪 + 进入根目录内联新建态（状态先于渲染注入，避免渲染后再改 store） */
function renderCreating(type: 'file' | 'directory'): void {
  useFileTreeStore.getState().setRootPath(ROOT);
  useFileTreeStore.getState().startCreate(ROOT, type);
  render(<FileTreePanel workingDir={ROOT} />);
}

/** 打开头部「更多操作」菜单 */
async function openMoreMenu(): Promise<void> {
  await userEvent.click(screen.getByLabelText(i18n.t('fileTree.moreActions')));
}

beforeEach(() => {
  vi.clearAllMocks();
  useFileTreeStore.getState().reset();
  useUiStore.setState({ sidebarView: 'threads' });
});

describe('FileTreePanel', () => {
  it('无激活会话：渲染空态引导（不渲染树）', () => {
    render(<FileTreePanel workingDir={null} />);
    expect(screen.getByText(i18n.t('home.noProject'))).toBeDefined();
    expect(screen.getByText(i18n.t('fileTree.emptyDesc'))).toBeDefined();
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('rootPath 尚未同步：渲染加载占位', () => {
    render(<FileTreePanel workingDir={ROOT} />);
    expect(screen.getByText(i18n.t('common.loading'))).toBeDefined();
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('就绪：渲染标题、role=tree 与以根目录名为名的 aria-label', () => {
    renderReady();
    expect(screen.getByText(i18n.t('sidebar.fileTree'))).toBeDefined();
    const tree = screen.getByRole('tree');
    expect(tree.getAttribute('aria-label')).toBe(i18n.t('fileTree.treeLabel', { name: 'proj' }));
    // 根节点行显示 basename
    expect(screen.getByText('proj')).toBeDefined();
  });

  it('返回按钮：切回会话列表视图', () => {
    useUiStore.setState({ sidebarView: 'fileTree' });
    renderReady();
    fireEvent.click(screen.getByLabelText(i18n.t('sidebar.backToThreads')));
    expect(useUiStore.getState().sidebarView).toBe('threads');
  });

  it('菜单「添加文件夹」：展开根目录并进入新建目录状态', async () => {
    renderReady();
    // 先收起根目录，验证菜单动作会重新展开
    useFileTreeStore.getState().setExpanded(ROOT, false);

    await openMoreMenu();
    await userEvent.click(await screen.findByText(i18n.t('fileTree.addFolder')));

    expect(useFileTreeStore.getState().expandedPaths.has(ROOT)).toBe(true);
    expect(useFileTreeStore.getState().creatingEntry).toEqual({
      parentDir: ROOT,
      type: 'directory',
    });
  });

  it('菜单「添加文件」：进入新建文件状态', async () => {
    renderReady();
    await openMoreMenu();
    await userEvent.click(await screen.findByText(i18n.t('fileTree.addFile')));

    expect(useFileTreeStore.getState().creatingEntry).toEqual({
      parentDir: ROOT,
      type: 'file',
    });
  });

  it('菜单「刷新」：转发到 useFileTree.refresh（数据面留在 hook）', async () => {
    renderReady();
    await openMoreMenu();
    await userEvent.click(await screen.findByText(i18n.t('fileTree.refresh')));

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('新建确认（目录）：转发 createDir(parentDir, name)', () => {
    renderCreating('directory');

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'newdir' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockCreateDir).toHaveBeenCalledWith(ROOT, 'newdir');
    expect(mockCreateFile).not.toHaveBeenCalled();
  });

  it('新建确认（文件）：转发 createFile(parentDir, name)', () => {
    renderCreating('file');

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'new.ts' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockCreateFile).toHaveBeenCalledWith(ROOT, 'new.ts');
    expect(mockCreateDir).not.toHaveBeenCalled();
  });
});
