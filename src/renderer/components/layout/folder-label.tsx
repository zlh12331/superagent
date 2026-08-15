// folder-label.tsx（自 Sidebar 拆分）
// 侧边栏 · 文件夹标签
// ──────────────────────────────
// 拆分背景：Sidebar 641 行，按职责提取
// ──────────────────────────────

// src/renderer/components/layout/Sidebar.tsx
// 侧边栏 · 会话列表 · 对齐原型布局
// ──────────────────────────────────────────────────────────────
// 职责：
// - sidebar-head：新建会话按钮 + 搜索框 + tabs（最近/归档）
// - sidebar-list：会话列表（thread-item 结构，按 folder 分组）
// - sidebar-foot：用户信息区域（占位，功能预留）
//
// 设计（对齐原型 docs/prototype/prototype-v2.html）：
// - class 命名：sidebar / sidebar-head / sidebar-search / sidebar-tabs /
//   sidebar-tab / sidebar-list / thread-group-label / folder-label /
//   folder-items / thread-item / ti-row / ti-dot / ti-content / ti-title /
//   ti-meta / ti-actions / sidebar-foot
// - 文学风视觉令牌：深棕主色 + 衬线标题 + 等宽元信息
//
// 状态分层（符合项目规范）：
// - L2 Zustand：useActiveSessionStore 维护激活会话 id
// - L3 TanStack Query：useSessionsQuery 拉取列表
// - L3 TanStack Mutation：useDeleteSession
// ──────────────────────────────────────────────────────────────

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
          {/* fl-add-btn：在此文件夹新建会话（对齐原型 5975-5980 行，hover 显示） */}
          {/* biome-ignore lint/a11y/useSemanticElements: 嵌套在 <button> 内，HTML 规范禁止 button-in-button，用 span[role=button] 绕过 */}
          <span
            className="fl-add-btn"
            role="button"
            tabIndex={0}
            aria-label={t('sidebar.newSessionIn', { name: folderName })}
            title={t('sidebar.newSessionInFolder')}
            onClick={(event) => {
              event.stopPropagation();
              onCreateInFolder(folderName);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                onCreateInFolder(folderName);
              }
            }}
          >
            <Plus className="size-3" strokeWidth={2.5} />
          </span>
        </button>
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

// ── 子组件：可拖拽会话项（@dnd-kit/sortable 包装） ────────────

/** 可拖拽会话项：useSortable 提供拖拽句柄属性，ti-dot 作为手柄 */
