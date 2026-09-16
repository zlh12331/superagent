// src/renderer/components/file-tree/FileTreePanel.tsx
// 文件树面板（Sidebar 内文件 Tab 内容）· 容器层
// ──────────────────────────────────────────────────────────────
// 职责：
// - 接收 workingDir（来自激活会话），调用 useFileTree 启动数据加载
// - 渲染顶部工具栏（返回 / 新建目录 / 新建文件 / 刷新）
// - 渲染根节点（FileTreeNode 递归）
// - 处理无激活会话 / workingDir 为空的状态
// - 把「用户意图」翻译为数据动作：新建走 useFileTreeOps、刷新走 useFileTree.refresh、
//   打开文件走 file-viewer-store（子树只收回调，不自行触达 IPC 与 store action）
//
// 设计：
// - 容器组件：仅负责生命周期 + 状态分支 + 意图编排，不参与节点渲染逻辑
// - 数据生命周期委托给 useFileTree hook（IPC + watch + 状态同步 + refresh）
// - 视觉对齐 Sidebar 文学风：根目录显示 workingDir basename
// ──────────────────────────────────────────────────────────────

import { ArrowLeft, Ellipsis, FilePlus, FolderOpen, FolderPlus, RefreshCw } from 'lucide-react';
import type { ReactElement } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useFileTree } from '@/hooks/use-file-tree';
import { useFileTreeOps } from '@/hooks/use-file-tree-ops';
import { useTranslation } from '@/i18n/use-translation';
import { basename } from '@/lib/utils';
import { type CreateEntryType, useFileTreeStore } from '@/stores/transient/file-tree-store';
import { useFileViewerStore } from '@/stores/transient/file-viewer-store';
import { useUiStore } from '@/stores/transient/ui-store';
import { FileTreeNode } from './FileTreeNode';

interface FileTreePanelProps {
  /** 当前激活会话的 workingDir（无激活会话时为 null） */
  readonly workingDir: string | null;
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
  // 启动文件树数据生命周期（IPC + watch + 状态同步），并取得手动刷新入口
  const { refresh } = useFileTree(workingDir);
  // 树编辑操作（新建文件 / 目录）——在容器层实例化一次，经回调注入子树
  const ops = useFileTreeOps();

  // 文件树视图返回（对齐参考项目 FileTree 头部返回按钮）
  const setSidebarView = useUiStore((state) => state.setSidebarView);

  // 读取根路径（用于判断是否已初始化）
  const rootPath = useFileTreeStore((s) => s.rootPath);

  const setExpanded = useFileTreeStore((s) => s.setExpanded);
  const startCreate = useFileTreeStore((s) => s.startCreate);

  // 文件点击回调：打开文件查看器（右侧面板显示内容）
  const openFile = useFileViewerStore((s) => s.openFile);

  // 头部菜单「新建」：展开根目录并把内联新建输入挂在根下
  // （不手写 useCallback：依赖含每渲染新建的 ops 对象，手写缓存本就失效；
  // 记忆化交给 React Compiler，见 AGENTS.md「渲染层写法标准」）
  const startCreateInRoot = (type: CreateEntryType): void => {
    if (rootPath === null) return;
    setExpanded(rootPath, true);
    startCreate(rootPath, type);
  };

  // 内联新建确认：按类型分流到对应的落盘动作（错误提示在 ops 内统一处理）
  const handleCreate = (parentDir: string, type: CreateEntryType, name: string): void => {
    void (type === 'file' ? ops.createFile(parentDir, name) : ops.createDir(parentDir, name));
  };

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

  // rootPath 已同步（useFileTree 内部 effect 会触发 setRootPath）
  // 首次渲染时可能为 null（effect 在 mount 后执行），显示加载占位
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
    <div className="flex h-full flex-col">
      {/* 头部（对齐参考项目 FileTree：返回按钮 + 标题 + 更多操作） */}
      <div className="sft-head">
        <button
          type="button"
          className="sft-back"
          onClick={() => setSidebarView('threads')}
          aria-label={t('sidebar.backToThreads')}
          title={t('sidebar.backToThreads')}
        >
          <ArrowLeft className="size-3.5" strokeWidth={2} />
        </button>
        <span className="sft-title">{t('sidebar.fileTree')}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="sft-more-btn"
              aria-label={t('fileTree.moreActions')}
              title={t('fileTree.moreActions')}
            >
              <Ellipsis className="size-3.5" strokeWidth={1.5} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => startCreateInRoot('directory')}>
              <FolderPlus className="size-3.5" strokeWidth={1.5} />
              {t('fileTree.addFolder')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => startCreateInRoot('file')}>
              <FilePlus className="size-3.5" strokeWidth={1.5} />
              {t('fileTree.addFile')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={refresh}>
              <RefreshCw className="size-3.5" strokeWidth={1.5} />
              {t('fileTree.refresh')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div
        className="file-tree min-h-0 flex-1"
        role="tree"
        aria-label={t('fileTree.treeLabel', { name: basename(rootPath) })}
      >
        <FileTreeNode
          path={rootPath}
          name={basename(rootPath)}
          type="directory"
          depth={0}
          onOpenFile={openFile}
          onCreate={handleCreate}
        />
      </div>
    </div>
  );
}
