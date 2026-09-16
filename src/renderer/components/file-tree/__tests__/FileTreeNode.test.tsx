// src/renderer/components/file-tree/__tests__/FileTreeNode.test.tsx
// 文件树节点单测（正向 / 边界 / 异常）
// ──────────────────────────────────────────────────────────────
// 覆盖：目录展开/折叠（点击 + 键盘）、子区三态（空目录 / 加载中 / 新建输入）、
// 新建确认经注入回调上报（类型/父目录/名称三元组）、文件节点打开（点击 + 键盘）、
// 激活态与新建在途态类名、缩进、子区 ARIA group 语义。
//
// 依赖收敛（2026-09 file-tree 审计）：新建动作改为回调注入（onCreate），
// 本文件不再 mock use-file-tree-ops —— 节点只上报意图，落盘由容器负责。
// ──────────────────────────────────────────────────────────────

import type { FileEntry } from '@code-agent/shared/renderer';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';

import { FileTreeNode } from '../FileTreeNode';

/** 构造文件树条目 */
function entry(name: string, type: 'file' | 'directory', parent = '/root'): FileEntry {
  return { name, path: `${parent}/${name}`, type, size: 0, modifiedAt: 0 };
}

/** 渲染目录节点（根）；onCreate 与 onOpenFile 均为可断言 spy */
function renderDir(onOpenFile = vi.fn()) {
  const onCreate = vi.fn();
  const view = render(
    <FileTreeNode
      path="/root"
      name="root"
      type="directory"
      depth={0}
      onOpenFile={onOpenFile}
      onCreate={onCreate}
    />,
  );
  return { onOpenFile, onCreate, ...view };
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
      onCreate={vi.fn()}
    />,
  );
  return { onOpenFile };
}

/** 进入「根目录下新建文件/目录」状态并渲染 */
function renderCreating(type: 'file' | 'directory') {
  useFileTreeStore.getState().setExpanded('/root', true);
  useFileTreeStore.getState().startCreate('/root', type);
  return renderDir();
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
      <FileTreeNode
        path="/root"
        name="root"
        type="directory"
        depth={0}
        onOpenFile={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    fireEvent.keyDown(screen.getByRole('treeitem'), { key: 'Enter' });
    expect(useFileTreeStore.getState().expandedPaths.has('/root')).toBe(true);
    unmount();

    useFileTreeStore.getState().reset();
    render(
      <FileTreeNode
        path="/root"
        name="root"
        type="directory"
        depth={0}
        onOpenFile={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    fireEvent.keyDown(screen.getByRole('treeitem'), { key: ' ' });
    expect(useFileTreeStore.getState().expandedPaths.has('/root')).toBe(true);
  });

  it('键盘非激活键（字母）：不触发展开/折叠', () => {
    useFileTreeStore.getState().setExpanded('/root', true);
    renderDir();
    fireEvent.keyDown(screen.getByRole('treeitem'), { key: 'a' });
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

  it('子区语义：展开后子节点容器为 fieldset（原生 role="group"，ARIA tree 模式）', () => {
    useFileTreeStore.getState().setExpanded('/root', true);
    const { container } = renderDir();
    const group = container.querySelector('.ft-children');
    expect(group?.tagName).toBe('FIELDSET');
  });

  it('新建中：渲染输入框且不显示空目录占位（让位给输入）', () => {
    useFileTreeStore.getState().setExpanded('/root', true);
    useFileTreeStore.getState().startCreate('/root', 'file');
    renderDir();
    expect(screen.getByRole('textbox')).toBeDefined();
    expect(screen.queryByText(i18n.t('fileTree.emptyDir'))).toBeNull();
  });

  it('新建确认：经 onCreate 上报 (父目录, 类型, 名称) 三元组', () => {
    const { onCreate } = renderCreating('file');
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'new.ts' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCreate).toHaveBeenCalledWith('/root', 'file', 'new.ts');
  });

  it('新建目录确认：类型上报为 directory（容器据此分流 createDir）', () => {
    const { onCreate } = renderCreating('directory');
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'newdir' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCreate).toHaveBeenCalledWith('/root', 'directory', 'newdir');
  });

  it('新建输入 Esc：取消新建状态（store.creatingEntry 复位），不触发 onCreate', () => {
    const { onCreate } = renderCreating('file');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(useFileTreeStore.getState().creatingEntry).toBeNull();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('边界：其他目录在新建时，本目录不受影响（creatingEntry 收窄正确）', () => {
    useFileTreeStore.getState().setExpanded('/root', true);
    // 新建流程挂在别的目录下
    useFileTreeStore.getState().startCreate('/other', 'file');
    renderDir();
    // 本目录不应渲染输入框，也不显示空目录占位之外的干扰
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(i18n.t('fileTree.emptyDir'))).toBeDefined();
  });

  it('异常：新建输入 Enter 提交不冒泡到 treeitem（目录展开状态不变）', () => {
    renderCreating('file');
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'new.ts' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // 输入框嵌套在 DirNode 的 treeitem 内：Enter 冒泡会命中 isActivateKey → toggleExpand
    expect(useFileTreeStore.getState().expandedPaths.has('/root')).toBe(true);
  });

  it('异常：新建输入空格不冒泡到 treeitem（空格是文件名合法字符）', () => {
    renderCreating('file');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: ' ' });
    // treeitem 对 Space 调 preventDefault + toggleExpand：冒泡会折叠目录并阻断空格输入
    expect(useFileTreeStore.getState().expandedPaths.has('/root')).toBe(true);
  });

  it('异常：新建输入 Esc 取消不冒泡到 treeitem（不折叠目录）', () => {
    renderCreating('file');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(useFileTreeStore.getState().creatingEntry).toBeNull();
    expect(useFileTreeStore.getState().expandedPaths.has('/root')).toBe(true);
  });

  it('缩进：depth 决定 paddingLeft（depth*12+8）', () => {
    const { container } = render(
      <FileTreeNode
        path="/root"
        name="root"
        type="directory"
        depth={2}
        onOpenFile={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    const rowWrap = container.querySelector('.ft-row-wrap') as HTMLElement;
    expect(rowWrap.style.paddingLeft).toBe('32px');
  });

  it('新建在途：父目录行带 pending 类（防重复操作的可视反馈）', () => {
    useFileTreeStore.getState().setPendingDir('/root', true);
    const { container } = render(
      <FileTreeNode
        path="/root"
        name="root"
        type="directory"
        depth={0}
        onOpenFile={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(container.querySelector('.ft-dir.pending')).not.toBeNull();
  });

  it('非在途：目录行无 pending 类', () => {
    const { container } = renderDir();
    expect(container.querySelector('.ft-dir.pending')).toBeNull();
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
      <FileTreeNode
        path="/root/a.ts"
        name="a.ts"
        type="file"
        depth={1}
        onOpenFile={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(screen.getByRole('treeitem').getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('.ft-file.active')).not.toBeNull();
  });

  it('非激活态：aria-selected=false 且无 active 类', () => {
    const { container } = render(
      <FileTreeNode
        path="/root/a.ts"
        name="a.ts"
        type="file"
        depth={1}
        onOpenFile={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(screen.getByRole('treeitem').getAttribute('aria-selected')).toBe('false');
    expect(container.querySelector('.ft-file.active')).toBeNull();
  });

  it('边界：父目录处于新建在途时，文件行不受影响（pending 仅作用于目录）', () => {
    useFileTreeStore.getState().setPendingDir('/root', true);
    const { container } = render(
      <FileTreeNode
        path="/root/a.ts"
        name="a.ts"
        type="file"
        depth={1}
        onOpenFile={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(container.querySelector('.ft-file.pending')).toBeNull();
  });

  it('边界：文件节点不订阅新建在途集合（无多余 store 依赖）', () => {
    // 目录在途标记与文件无关：即便同名集合被填充，文件行 className 保持干净
    useFileTreeStore.getState().setPendingDir('/root/a.ts', true);
    const { container } = render(
      <FileTreeNode
        path="/root/a.ts"
        name="a.ts"
        type="file"
        depth={1}
        onOpenFile={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(container.querySelector('.ft-file')?.className).not.toContain('pending');
  });
});
