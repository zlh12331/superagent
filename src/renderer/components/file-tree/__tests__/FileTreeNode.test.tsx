// src/renderer/components/file-tree/__tests__/FileTreeNode.test.tsx
// 文件树节点单测（正向 / 边界 / 异常）
// ──────────────────────────────────────────────────────────────
// 该组件此前零直接覆盖（FileTreeNode/DirNode/DirChildren/FileNode 全部未测）。
// 覆盖：目录展开/折叠（点击 + 键盘）、子区三态（空目录 / 加载中 / 新建输入）、
// 新建确认分流（createFile / createDir）、文件节点打开（点击 + 键盘）、
// 激活态与 pending 态类名、缩进计算。
// ──────────────────────────────────────────────────────────────

import type { FileEntry } from '@code-agent/shared/renderer';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';

import { FileTreeNode } from '../FileTreeNode';

const { mockCreateFile, mockCreateDir } = vi.hoisted(() => ({
  mockCreateFile: vi.fn(async () => true),
  mockCreateDir: vi.fn(async () => true),
}));

vi.mock('@/hooks/use-file-tree-ops', () => ({
  useFileTreeOps: () => ({ createFile: mockCreateFile, createDir: mockCreateDir }),
}));

/** 构造文件树条目 */
function entry(name: string, type: 'file' | 'directory', parent = '/root'): FileEntry {
  return { name, path: `${parent}/${name}`, type, size: 0, modifiedAt: 0 };
}

/** 渲染目录节点（根） */
function renderDir(onOpenFile = vi.fn()) {
  render(
    <FileTreeNode path="/root" name="root" type="directory" depth={0} onOpenFile={onOpenFile} />,
  );
  return { onOpenFile };
}

/** 渲染文件节点 */
function renderFile(onOpenFile = vi.fn(), depth = 1) {
  render(
    <FileTreeNode
      path="/root/a.ts"
      name="a.ts"
      type="file"
      depth={depth}
      onOpenFile={onOpenFile}
    />,
  );
  return { onOpenFile };
}

beforeEach(() => {
  vi.clearAllMocks();
  useFileTreeStore.getState().reset();
});

describe('FileTreeNode · 目录节点', () => {
  it('未展开：aria-expanded=false 且不渲染子区', () => {
    renderDir();
    expect(screen.getByRole('treeitem').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(i18n.t('fileTree.emptyDir'))).toBeNull();
  });

  it('点击行：展开并渲染子条目', () => {
    useFileTreeStore.getState().setEntries('/root', [entry('a.ts', 'file')]);
    renderDir();
    fireEvent.click(screen.getByRole('button'));
    expect(useFileTreeStore.getState().expandedPaths.has('/root')).toBe(true);
    expect(screen.getByText('a.ts')).toBeDefined();
  });

  it('键盘 Enter / Space：触发展开（与 button 默认行为对齐）', () => {
    const { unmount } = render(
      <FileTreeNode path="/root" name="root" type="directory" depth={0} onOpenFile={vi.fn()} />,
    );
    fireEvent.keyDown(screen.getByRole('treeitem'), { key: 'Enter' });
    expect(useFileTreeStore.getState().expandedPaths.has('/root')).toBe(true);
    unmount();

    useFileTreeStore.getState().reset();
    render(
      <FileTreeNode path="/root" name="root" type="directory" depth={0} onOpenFile={vi.fn()} />,
    );
    fireEvent.keyDown(screen.getByRole('treeitem'), { key: ' ' });
    expect(useFileTreeStore.getState().expandedPaths.has('/root')).toBe(true);
  });

  it('已展开且无子条目：显示「空目录」占位', () => {
    useFileTreeStore.getState().setExpanded('/root', true);
    renderDir();
    expect(screen.getByText(i18n.t('fileTree.emptyDir'))).toBeDefined();
  });

  it('已展开且加载中：显示加载中占位（优先于空目录）', () => {
    useFileTreeStore.getState().setExpanded('/root', true);
    useFileTreeStore.getState().setLoading('/root', true);
    renderDir();
    expect(screen.getByText(i18n.t('common.loading'))).toBeDefined();
    expect(screen.queryByText(i18n.t('fileTree.emptyDir'))).toBeNull();
  });

  it('子条目：目录与文件各自递归渲染为 treeitem', () => {
    const store = useFileTreeStore.getState();
    store.setEntries('/root', [entry('sub', 'directory'), entry('a.ts', 'file')]);
    store.setExpanded('/root', true);
    renderDir();
    // 根 + 子目录 + 子文件
    expect(screen.getAllByRole('treeitem')).toHaveLength(3);
    expect(screen.getByText('sub')).toBeDefined();
    expect(screen.getByText('a.ts')).toBeDefined();
  });

  it('新建中：渲染输入框且不显示空目录占位（让位给输入）', () => {
    const store = useFileTreeStore.getState();
    store.setExpanded('/root', true);
    store.startCreate('/root', 'file');
    renderDir();
    expect(screen.getByRole('textbox')).toBeDefined();
    expect(screen.queryByText(i18n.t('fileTree.emptyDir'))).toBeNull();
  });

  it('新建文件确认：调 createFile(parentDir, name)', async () => {
    const store = useFileTreeStore.getState();
    store.setExpanded('/root', true);
    store.startCreate('/root', 'file');
    renderDir();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'new.ts' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mockCreateFile).toHaveBeenCalledWith('/root', 'new.ts'));
    expect(mockCreateDir).not.toHaveBeenCalled();
  });

  it('新建目录确认：调 createDir(parentDir, name)', async () => {
    const store = useFileTreeStore.getState();
    store.setExpanded('/root', true);
    store.startCreate('/root', 'directory');
    renderDir();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'newdir' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mockCreateDir).toHaveBeenCalledWith('/root', 'newdir'));
    expect(mockCreateFile).not.toHaveBeenCalled();
  });

  it('新建输入 Esc：取消新建状态（store.creatingEntry 复位）', () => {
    const store = useFileTreeStore.getState();
    store.setExpanded('/root', true);
    store.startCreate('/root', 'file');
    renderDir();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(useFileTreeStore.getState().creatingEntry).toBeNull();
    expect(mockCreateFile).not.toHaveBeenCalled();
  });

  it('缩进：depth 决定 paddingLeft（depth*12+8）', () => {
    const { container } = render(
      <FileTreeNode path="/root" name="root" type="directory" depth={2} onOpenFile={vi.fn()} />,
    );
    const rowWrap = container.querySelector('.ft-row-wrap') as HTMLElement;
    expect(rowWrap.style.paddingLeft).toBe('32px');
  });
});

describe('FileTreeNode · 文件节点', () => {
  it('点击：先激活再打开', () => {
    const { onOpenFile } = renderFile();
    fireEvent.click(screen.getByRole('button'));
    expect(useFileTreeStore.getState().activeFilePath).toBe('/root/a.ts');
    expect(onOpenFile).toHaveBeenCalledWith('/root/a.ts');
  });

  it('键盘：Enter / Space 打开，其他键不响应', () => {
    const { onOpenFile } = renderFile();
    const node = screen.getByRole('treeitem');
    fireEvent.keyDown(node, { key: 'a' });
    expect(onOpenFile).not.toHaveBeenCalled();
    fireEvent.keyDown(node, { key: 'Enter' });
    expect(onOpenFile).toHaveBeenCalledWith('/root/a.ts');
  });

  it('激活态：aria-selected=true 且带 active 类', () => {
    useFileTreeStore.getState().setActiveFile('/root/a.ts');
    const { container } = render(
      <FileTreeNode path="/root/a.ts" name="a.ts" type="file" depth={1} onOpenFile={vi.fn()} />,
    );
    expect(screen.getByRole('treeitem').getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('.ft-file.active')).not.toBeNull();
  });

  it('操作中：带 pending 类（防重复操作的可视反馈）', () => {
    useFileTreeStore.getState().setPendingOp('/root/a.ts', true);
    const { container } = render(
      <FileTreeNode path="/root/a.ts" name="a.ts" type="file" depth={1} onOpenFile={vi.fn()} />,
    );
    expect(container.querySelector('.ft-file.pending')).not.toBeNull();
  });

  it('非激活态：aria-selected=false 且无 active 类', () => {
    const { container } = render(
      <FileTreeNode path="/root/a.ts" name="a.ts" type="file" depth={1} onOpenFile={vi.fn()} />,
    );
    expect(screen.getByRole('treeitem').getAttribute('aria-selected')).toBe('false');
    expect(container.querySelector('.ft-file.active')).toBeNull();
  });
});
