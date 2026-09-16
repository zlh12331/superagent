// src/renderer/components/file-tree/FileTreePanel.tsx
// 文件树面板（Sidebar 内文件 Tab 内容）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 接收 workingDir（来自激活会话），调用 useFileTree 启动数据加载
// - 渲染顶部工具栏（新建文件 / 新建目录按钮）
// - 渲染根节点（FileTreeNode 递归）
// - 处理无激活会话 / workingDir 为空的状态
// - 文件点击回调（打开右侧 FileViewerPanel）
//
// 设计：
// - 容器组件：仅负责生命周期 + 状态分支，不参与节点渲染逻辑
// - 数据生命周期委托给 useFileTree hook（IPC + watch + 状态同步）
// - 视觉对齐 Sidebar 文学风：根目录显示 workingDir basename
// ──────────────────────────────────────────────────────────────

import { ArrowLeft, Ellipsis, FilePlus, FolderOpen, FolderPlus, RefreshCw } from 'lucide-react';
import { type ReactElement, useCallback } from 'react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useFileTree } from '@/hooks/use-file-tree';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';
import { basename } from '@/lib/utils';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';
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
  // 启动文件树数据生命周期（IPC + watch + 状态同步）
  useFileTree(workingDir);

  // 文件树视图返回（对齐参考项目 FileTree 头部返回按钮）
  const setSidebarView = useUiStore((state) => state.setSidebarView);

  // 读取根路径（用于判断是否已初始化）
  const rootPath = useFileTreeStore((s) => s.rootPath);

  // 文件点击回调：打开文件查看器（右侧面板显示内容）
  const openFile = useFileViewerStore((s) => s.openFile);

  // 头部菜单操作（三点点按钮 → 添加文件夹 / 添加文件 / 刷新）
  const refreshTree = useCallback(async (): Promise<void> => {
    if (rootPath === null || (await refreshExpandedDirs(rootPath)) > 0) {
      // 失败反馈（2026-09-06 审计修复）：此前完全静默，目录陈旧时用户无从判断
      toast.warning(t('fileTree.refreshFailed'));
    }
  }, [rootPath, t]);
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
    <div className="flex h-full flex-col">
      {/* 头部（对齐参考项目 FileTree：返回按钮 + 标题 + 刷新） */}
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
              className="sft-more-btn text-muted-foreground hover:bg-muted hover:text-foreground ml-auto flex size-5 shrink-0 cursor-pointer items-center justify-center rounded transition-colors"
              aria-label={t('fileTree.moreActions')}
              title={t('fileTree.moreActions')}
            >
              <Ellipsis className="size-3.5" strokeWidth={1.5} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => {
                handleNewDir();
              }}
            >
              <FolderPlus className="size-3.5" strokeWidth={1.5} />
              {t('fileTree.addFolder')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                handleNewFile();
              }}
            >
              <FilePlus className="size-3.5" strokeWidth={1.5} />
              {t('fileTree.addFile')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                void refreshTree();
              }}
            >
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
        />
      </div>
    </div>
  );
}

/**
 * 重拉根目录 + 所有已展开目录的条目
 *
 * @returns 失败目录数（0 表示全部成功）——调用方据此决定是否提示
 */
async function refreshExpandedDirs(rootPath: string): Promise<number> {
  if (typeof window === 'undefined' || window.api === undefined) {
    return 0;
  }
  const paths = [...new Set([rootPath, ...useFileTreeStore.getState().expandedPaths])];
  let failed = 0;
  await Promise.allSettled(
    paths.map(async (path) => {
      try {
        const res = await window.api.file.list({ path, depth: 1, includeHidden: false });
        useFileTreeStore.getState().setEntries(path, unwrap(res).entries);
      } catch {
        // 单个目录失败不中断其余目录（allSettled 语义），最后统一提示一次
        failed += 1;
      }
    }),
  );
  return failed;
}
