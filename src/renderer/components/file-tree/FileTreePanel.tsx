// src/renderer/components/file-tree/FileTreePanel.tsx
// 文件树面板（Sidebar 内文件 Tab 内容）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 接收 workingDir（来自激活会话），调用 useFileTree 启动数据加载
// - 渲染顶部工具栏（新建文件 / 新建目录按钮）
// - 渲染根节点（FileTreeNode 递归）
// - 处理无激活会话 / workingDir 为空的状态
// - 文件点击回调（打开 FileViewerDialog）
//
// 设计：
// - 容器组件：仅负责生命周期 + 状态分支，不参与节点渲染逻辑
// - 数据生命周期委托给 useFileTree hook（IPC + watch + 状态同步）
// - 视觉对齐 Sidebar 文学风：根目录显示 workingDir basename
// ──────────────────────────────────────────────────────────────

import { FilePlus, FolderOpen, FolderPlus } from 'lucide-react';
import { type ReactElement, useCallback } from 'react';

import { useFileTree } from '@/hooks/use-file-tree';
import { useTranslation } from '@/i18n/use-translation';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';
import { useFileViewerStore } from '@/stores/transient/file-viewer-store';

import { FileTreeNode } from './FileTreeNode';

interface FileTreePanelProps {
  /** 当前激活会话的 workingDir（无激活会话时为 null） */
  readonly workingDir: string | null;
}

/**
 * 从绝对路径提取 basename（兼容 Windows 反斜杠与 POSIX 正斜杠）
 *
 * 用于根节点显示名称。不依赖 node:path（渲染层无 Node API）。
 */
function basename(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  const lastBackslash = path.lastIndexOf('\\');
  const idx = Math.max(lastSlash, lastBackslash);
  if (idx === -1) return path;
  return path.slice(idx + 1);
}

/**
 * 文件树面板
 *
 * 在 Sidebar 内「文件」Tab 中渲染。
 * 工作目录来自激活会话，切换会话时自动重置状态并重新加载。
 *
 * @example
 * ```tsx
 * <FileTreePanel workingDir={activeSession?.workingDir ?? null} />
 * ```
 */
export function FileTreePanel({ workingDir }: FileTreePanelProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 启动文件树数据生命周期（IPC + watch + 状态同步）
  useFileTree(workingDir);

  // 读取根路径（用于判断是否已初始化）
  const rootPath = useFileTreeStore((s) => s.rootPath);

  // 文件点击回调：打开 FileViewerDialog（shiki 语法高亮只读查看器）
  const openFile = useFileViewerStore((s) => s.openFile);
  const handleOpenFile = useCallback(
    (filePath: string) => {
      openFile(filePath);
    },
    [openFile],
  );

  // 工具栏：在根目录下新建文件/目录
  const setExpanded = useFileTreeStore((s) => s.setExpanded);
  const startCreate = useFileTreeStore((s) => s.startCreate);
  const handleNewFile = useCallback((): void => {
    if (rootPath === null) return;
    setExpanded(rootPath, true);
    startCreate(rootPath, 'file');
  }, [rootPath, setExpanded, startCreate]);
  const handleNewDir = useCallback((): void => {
    if (rootPath === null) return;
    setExpanded(rootPath, true);
    startCreate(rootPath, 'directory');
  }, [rootPath, setExpanded, startCreate]);

  // 无激活会话或 workingDir 为空
  if (workingDir === null) {
    return (
      <div className="ft-empty-state">
        <FolderOpen size={24} strokeWidth={1.25} className="ft-empty-icon" />
        <p className="ft-empty-title">{t('home.noProject')}</p>
        <p className="ft-empty-desc">{t('fileTree.emptyDesc')}</p>
      </div>
    );
  }

  // rootPath 已同步（useFileTree 内部 useEffect 会触发 setRootPath）
  // 首次渲染时可能为 null（useEffect 在 mount 后执行），显示加载占位
  if (rootPath === null) {
    return (
      <div className="ft-empty-state">
        <p className="ft-empty-title">{t('common.loading')}</p>
      </div>
    );
  }

  // 渲染工具栏 + 根节点（递归展开子树）
  // 使用 div 而非 nav：nav 是非交互元素，与 role="tree" 冲突（biome a11y 规则）
  return (
    <div
      className="file-tree"
      role="tree"
      aria-label={t('fileTree.treeLabel', { name: basename(rootPath) })}
    >
      <div className="ft-toolbar" role="toolbar" aria-label={t('fileTree.toolbarLabel')}>
        <button
          type="button"
          className="ft-toolbar-btn"
          onClick={handleNewFile}
          aria-label={t('fileTree.newFileInRoot')}
          title={t('fileTree.newFile')}
          tabIndex={-1}
        >
          <FilePlus size={12} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="ft-toolbar-btn"
          onClick={handleNewDir}
          aria-label={t('fileTree.newDirInRoot')}
          title={t('fileTree.newDir')}
          tabIndex={-1}
        >
          <FolderPlus size={12} strokeWidth={1.75} />
        </button>
      </div>
      <FileTreeNode
        path={rootPath}
        name={basename(rootPath)}
        type="directory"
        depth={0}
        onOpenFile={handleOpenFile}
      />
    </div>
  );
}
