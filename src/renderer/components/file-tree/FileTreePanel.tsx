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
  const { t } = useTranslation();
  const { refresh } = useFileTree(workingDir);
  const ops = useFileTreeOps();

  const setSidebarView = useUiStore((state) => state.setSidebarView);

  const rootPath = useFileTreeStore((s) => s.rootPath);

  const setExpanded = useFileTreeStore((s) => s.setExpanded);
  const startCreate = useFileTreeStore((s) => s.startCreate);

  const openFile = useFileViewerStore((s) => s.openFile);

  const startCreateInRoot = (type: CreateEntryType): void => {
    if (rootPath === null) return;
    setExpanded(rootPath, true);
    startCreate(rootPath, type);
  };

  const handleCreate = (parentDir: string, type: CreateEntryType, name: string): void => {
    void (type === 'file' ? ops.createFile(parentDir, name) : ops.createDir(parentDir, name));
  };

  if (workingDir === null) {
    return (
      <div className="ft-empty-state">
        <FolderOpen size={24} strokeWidth={1.25} className="ft-empty-icon" />
        <p className="ft-empty-title">{t('home.noProject')}</p>
        <p className="ft-empty-desc">{t('fileTree.emptyDesc')}</p>
      </div>
    );
  }

  if (rootPath === null) {
    return (
      <div className="ft-empty-state">
        <p className="ft-empty-title">{t('common.loading')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
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
