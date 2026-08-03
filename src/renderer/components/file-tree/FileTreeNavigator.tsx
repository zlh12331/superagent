// src/renderer/components/file-tree/FileTreeNavigator.tsx
// 文件树导航（react-arborist 虚拟化树，FileViewerDialog 左侧栏）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 展示当前工作区（useFileTreeStore.rootPath）的只读文件树
// - 按需加载：react-arborist 无内置懒加载，用受控 data + onToggle 手动加载子节点
// - 点击文件：切换 FileViewerDialog 当前查看的文件
//
// 设计（与 FileTreePanel 自研树的边界）：
// - FileTreePanel（侧边栏）：全功能树（新建/重命名/右键菜单/watch 同步）
// - FileTreeNavigator（查看器侧栏）：轻量只读导航，react-arborist 渲染
//   虚拟化 + 键盘导航由 react-arborist 内置，无需自研
// ──────────────────────────────────────────────────────────────

import { File, Folder, FolderOpen } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { type NodeRendererProps, Tree } from 'react-arborist';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';
import { useFileViewerStore } from '@/stores/transient/file-viewer-store';

/** react-arborist 节点数据（id = 绝对路径；children 未加载时为 undefined） */
interface FileNode {
  readonly id: string;
  readonly name: string;
  readonly isDirectory: boolean;
  readonly children?: FileNode[];
}

/** 从绝对路径提取 basename（兼容 Windows 反斜杠与 POSIX 正斜杠） */
function basename(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  const lastBackslash = path.lastIndexOf('\\');
  const idx = Math.max(lastSlash, lastBackslash);
  if (idx === -1) return path;
  return path.slice(idx + 1);
}

/** 不可变更新树：找到 id 节点应用 updater（其余节点原样保留） */
function updateNode(
  nodes: readonly FileNode[],
  id: string,
  updater: (node: FileNode) => FileNode,
): FileNode[] {
  return nodes.map((node) => {
    if (node.id === id) {
      return updater(node);
    }
    if (node.children === undefined) {
      return node;
    }
    return { ...node, children: updateNode(node.children, id, updater) };
  });
}

/**
 * 文件树导航组件（只读，按需加载）
 *
 * 挂载在 FileViewerDialog 内容区左侧。
 * 树根 = 当前会话 workingDir（与打开文件的树一致）。
 * 展开目录时通过 file:list IPC 加载子节点（children 注入受控 data）。
 */
export function FileTreeNavigator(): ReactElement | null {
  const rootPath = useFileTreeStore((s) => s.rootPath);

  // 受控树数据（根节点 + 已加载的子节点）
  const [treeData, setTreeData] = useState<readonly FileNode[]>([]);

  // rootPath 变化（会话切换）：重置树
  useEffect(() => {
    if (rootPath === null) {
      setTreeData([]);
      return;
    }
    setTreeData([{ id: rootPath, name: basename(rootPath), isDirectory: true }]);
  }, [rootPath]);

  // 展开目录时按需加载子节点（react-arborist 无内置懒加载，onToggle 手动注入）
  const handleToggle = useCallback(async (id: string) => {
    const response = await window.api.file.list({ path: id, depth: 1, includeHidden: false });
    if (!('data' in response)) {
      return;
    }
    const children: FileNode[] = response.data.entries.map((entry) => ({
      id: entry.path,
      name: entry.name,
      isDirectory: entry.type === 'directory',
    }));
    setTreeData((prev) => updateNode(prev, id, (node) => ({ ...node, children })));
  }, []);

  if (rootPath === null) {
    return null;
  }

  return (
    <nav className="file-tree-navigator" aria-label="文件树导航">
      <Tree<FileNode>
        data={treeData}
        onToggle={handleToggle}
        rowHeight={24}
        indent={12}
        padding={4}
        openByDefault={false}
        initialOpenState={{ [rootPath]: true }}
      >
        {FileNodeRow}
      </Tree>
    </nav>
  );
}

/**
 * 单行节点渲染
 *
 * - 目录：文件夹图标 + 名称，点击折叠/展开
 * - 文件：文件图标 + 名称，点击打开（FileViewerDialog 切换当前文件）
 */
function FileNodeRow({ node, style, dragHandle }: NodeRendererProps<FileNode>): ReactElement {
  const openFile = useFileViewerStore((s) => s.openFile);
  const isSelected = node.isSelected;
  const Icon = node.isInternal ? (node.isOpen ? FolderOpen : Folder) : File;

  return (
    <div
      ref={dragHandle}
      style={style}
      className={`file-tree-nav-row${isSelected ? ' selected' : ''}`}
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={node.isInternal ? node.isOpen : undefined}
      tabIndex={0}
      title={node.data.name}
      onClick={() => {
        // 目录：折叠/展开（展开触发 onToggle 懒加载）；文件：切换查看器当前文件
        if (node.isInternal) {
          node.toggle();
        } else {
          openFile(node.data.id);
        }
      }}
      onKeyDown={(event) => {
        // 键盘可达性：Enter / Space 与点击行为一致
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (node.isInternal) {
            node.toggle();
          } else {
            openFile(node.data.id);
          }
        }
      }}
    >
      <Icon size={13} strokeWidth={1.75} className="file-tree-nav-icon" />
      <span className="file-tree-nav-name">{node.data.name}</span>
    </div>
  );
}
