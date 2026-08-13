// src/renderer/components/file-tree/FileTreeNode.test.tsx
// 文件树节点「更多」菜单补测（A2 修复后：重命名/删除/复制路径/目录内新建可达）

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFileTreeStore } from '@/stores/transient/file-tree-store';
import { FileTreeNode } from './FileTreeNode';

const FILE_ENTRY = {
  path: 'C:\\proj\\a.ts',
  name: 'a.ts',
  type: 'file' as const,
  size: 10,
  modifiedAt: 0,
};

describe('FileTreeNode 更多菜单', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFileTreeStore.getState().reset();
    useFileTreeStore.setState({ rootPath: 'C:\\proj', expandedPaths: new Set(['C:\\proj']) });
    useFileTreeStore.getState().setEntries('C:\\proj', [FILE_ENTRY]);
    // 剪贴板 jsdom 无实现：mock writeText（defineProperty——navigator.clipboard 为只读 getter）
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
      writable: true,
    });
    // file 域注入 delete mock（其他方法按需）
    window.api.file = { delete: vi.fn(async () => ({ data: { ok: true } })) } as never;
  });

  function renderNode(type: 'file' | 'directory') {
    const isFile = type === 'file';
    return render(
      <FileTreeNode
        path={isFile ? FILE_ENTRY.path : 'C:\\proj'}
        name={isFile ? 'a.ts' : 'proj'}
        type={type}
        depth={0}
        onOpenFile={vi.fn()}
      />,
    );
  }

  /** 打开第 index 个节点（目录渲染含子节点，多个「更多」按钮并存）的菜单 */
  async function openMenu(index = 0) {
    const user = userEvent.setup();
    const trigger = screen.getAllByLabelText('更多操作')[index];
    if (trigger === undefined) throw new Error('more button not found');
    await user.click(trigger);
  }

  it('文件节点：重命名 → renamingPath 置位（内联编辑态触发）', async () => {
    renderNode('file');
    await openMenu();
    await userEvent.setup().click(screen.getByText('重命名'));
    expect(useFileTreeStore.getState().renamingPath).toBe(FILE_ENTRY.path);
  });

  it('文件节点：删除 → file:delete IPC + 路径正确', async () => {
    renderNode('file');
    await openMenu();
    await userEvent.setup().click(screen.getByText('删除'));
    await vi.waitFor(() => {
      const deleteMock = (window.api.file as unknown as { delete: ReturnType<typeof vi.fn> })
        .delete;
      expect(deleteMock).toHaveBeenCalledWith({ path: FILE_ENTRY.path, recursive: true });
    });
  });

  it('文件节点：复制路径 → navigator.clipboard.writeText + 成功 toast', async () => {
    renderNode('file');
    // userEvent.setup() 会安装自己的 clipboard stub（jsdom 无原生实现），
    // 因此先 setup 再 spyOn 其 writeText
    const user = userEvent.setup();
    const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const trigger = screen.getAllByLabelText('更多操作')[0];
    if (trigger === undefined) throw new Error('more button not found');
    await user.click(trigger);
    await user.click(screen.getByText('复制路径'));
    await vi.waitFor(() => {
      expect(writeTextSpy).toHaveBeenCalledWith(FILE_ENTRY.path);
    });
  });

  it('目录节点：菜单含新建文件/新建目录/复制路径/重命名/删除五项', async () => {
    renderNode('directory');
    await openMenu();
    for (const label of ['新建文件', '新建目录', '复制路径', '重命名', '删除']) {
      expect(screen.getByText(label)).toBeDefined();
    }
  });

  it('目录节点：新建文件 → creatingEntry 指向该目录并展开', async () => {
    renderNode('directory');
    await openMenu();
    await userEvent.setup().click(screen.getByText('新建文件'));
    const s = useFileTreeStore.getState();
    expect(s.creatingEntry).toMatchObject({ parentDir: 'C:\\proj', type: 'file' });
    expect(s.expandedPaths.has('C:\\proj')).toBe(true);
  });
});
