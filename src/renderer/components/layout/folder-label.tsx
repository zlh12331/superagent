// src/renderer/components/layout/folder-label.tsx
// 侧边栏 · 文件夹标签行（折叠开关 + 新建 + 右键菜单）
// ──────────────────────────────
// 拆分背景（2026-08 重构）：自 Sidebar 641 行按职责提取。
// 职责：渲染一个文件夹分组标签——折叠/展开、组内新建会话入口、
// 右键菜单（新建 / 在资源管理器中打开 / 删除整组）。
// 纯展示：所有动作经 props 回调上报给 Sidebar，自身不触达 store 与 IPC。
// ──────────────────────────────

import { FolderOpen, Plus, Trash2 } from 'lucide-react';
import type { ReactElement } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

interface FolderLabelProps {
  readonly folderName: string;
  /** 是否折叠（折叠时隐藏该组会话项） */
  readonly collapsed: boolean;
  /** 切换折叠 */
  readonly onToggle: () => void;
  /** 在此文件夹内新建会话（fl-add-btn 触发） */
  readonly onCreateInFolder: (folderName: string) => void;
  /** 在资源管理器中打开文件夹（右键菜单） */
  readonly onOpenInExplorer: (folderName: string) => void;
  /** 删除文件夹（右键菜单——删除该组所有会话，确认后执行） */
  readonly onDeleteFolder: (folderName: string) => void;
}

export function FolderLabel({
  folderName,
  collapsed,
  onToggle,
  onCreateInFolder,
  onOpenInExplorer,
  onDeleteFolder,
}: FolderLabelProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* 文件夹标签行：折叠开关 + 独立"新建"按钮平级可聚焦（避免 button 内嵌 button / span 的嵌套交互） */}
        <div className="folder-label-cell">
          <button
            type="button"
            className={cn('folder-label', collapsed && 'collapsed')}
            onClick={onToggle}
            aria-expanded={!collapsed}
          >
            <span className="fl-chevron">
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                role="img"
                aria-label={t('sidebar.collapseFolder')}
              >
                <title>{t('sidebar.collapseFolder')}</title>
                <path d="M6 9l6 6 6-6" />
              </svg>
            </span>
            <span className="fl-icon">
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                role="img"
                aria-label={t('sidebar.folder')}
              >
                <title>{t('sidebar.folder')}</title>
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </span>
            <span className="fl-name">
              {folderName.length > 0 ? folderName : t('sidebar.unlabeled')}
            </span>
          </button>
          {/* 独立"新建"按钮（由原内嵌 span 移出为平级 button，消除嵌套交互；hover 显示见 .folder-label-cell） */}
          <button
            type="button"
            className="fl-add-btn"
            aria-label={t('sidebar.newSessionIn', { name: folderName })}
            title={t('sidebar.newSessionInFolder')}
            onClick={() => onCreateInFolder(folderName)}
          >
            <Plus className="size-3" strokeWidth={2.5} />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onCreateInFolder(folderName)}>
          <Plus className="size-3.5" strokeWidth={1.5} />
          {t('sidebar.newTaskInFolder')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onOpenInExplorer(folderName)}>
          <FolderOpen className="size-3.5" strokeWidth={1.5} />
          {t('sidebar.openInExplorer')}
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => onDeleteFolder(folderName)}>
          <Trash2 className="size-3.5" strokeWidth={1.5} />
          {t('sidebar.deleteFolder')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
