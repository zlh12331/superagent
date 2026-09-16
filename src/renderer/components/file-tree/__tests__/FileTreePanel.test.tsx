// src/renderer/components/file-tree/__tests__/FileTreePanel.test.tsx
// 文件树面板单测（正向 / 边界 / 异常）
// ──────────────────────────────────────────────────────────────
// 该组件此前零直接覆盖。覆盖：无工作目录空态、rootPath 未就绪占位、
// 就绪态的树语义与根节点名、返回按钮、菜单三项动作（新建目录/文件/刷新）
// 以及刷新失败的集中提示。
// 数据生命周期（IPC + watch）不属于本文件范围 → mock useFileTree 为空实现，
// 状态直接由 store 注入。
// ──────────────────────────────────────────────────────────────

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';
import { useUiStore } from '@/stores/transient/ui-store';

import { FileTreePanel } from '../FileTreePanel';

const { mockToastWarning, mockList } = vi.hoisted(() => ({
  mockToastWarning: vi.fn(),
  mockList: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { warning: mockToastWarning, error: vi.fn(), success: vi.fn() },
}));

// 数据生命周期（IPC + watch + 状态同步）单独由 hooks 测试覆盖
vi.mock('@/hooks/use-file-tree', () => ({ useFileTree: vi.fn() }));

const ROOT = 'C:\\proj';

/** 渲染面板并等待就绪（rootPath 已同步） */
function renderReady(): void {
  useFileTreeStore.getState().setRootPath(ROOT);
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
  mockList.mockResolvedValue({ data: { entries: [] } });
  window.api.file = { list: mockList } as never;
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

  it('菜单「刷新」：重拉目录条目写入 store（全部成功时不提示）', async () => {
    renderReady();
    mockList.mockResolvedValue({
      data: {
        entries: [{ name: 'a.ts', path: `${ROOT}\\a.ts`, type: 'file', size: 0, modifiedAt: 0 }],
      },
    });

    await openMoreMenu();
    await userEvent.click(await screen.findByText(i18n.t('fileTree.refresh')));

    await waitFor(() => expect(useFileTreeStore.getState().entries.get(ROOT)).toHaveLength(1));
    expect(mockToastWarning).not.toHaveBeenCalled();
  });

  it('菜单「刷新」异常：目录拉取失败时集中提示一次', async () => {
    renderReady();
    mockList.mockRejectedValue(new Error('ipc down'));

    await openMoreMenu();
    await userEvent.click(await screen.findByText(i18n.t('fileTree.refresh')));

    await waitFor(() =>
      expect(mockToastWarning).toHaveBeenCalledWith(i18n.t('fileTree.refreshFailed')),
    );
  });

  it('边界：浏览器模式（window.api 缺失）：刷新静默成功，不误报失败', async () => {
    (window as unknown as { api: undefined }).api = undefined;
    renderReady();

    await openMoreMenu();
    await userEvent.click(await screen.findByText(i18n.t('fileTree.refresh')));

    // refreshExpandedDirs 守卫直接返回 0（全部成功语义）→ 不调 IPC、不弹提示
    expect(mockList).not.toHaveBeenCalled();
    expect(mockToastWarning).not.toHaveBeenCalled();
  });
});
