// thread-item.tsx（自 Sidebar 拆分）
// 侧边栏 · 会话线程项（含拖拽排序）
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

import { useSortable } from '@dnd-kit/sortable';
import { FolderOpen, FolderTree, MoreVertical, Pencil, Pin, Trash2 } from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useRenameSession } from '@/hooks/use-sessions';
import { useTranslation } from '@/i18n/use-translation';
import { formatRelativeTime } from '@/lib/format-time';
import { cn } from '@/lib/utils';

/** SortableThreadItem props */
interface SortableThreadItemProps {
  readonly sessionId: string;
  readonly folderName: string;
  readonly title: string;
  readonly lastMessage: string | undefined;
  readonly updatedAt: number;
  readonly isActive: boolean;
  readonly isDeleting: boolean;
  readonly isPinned: boolean;
  /** 搜索匹配高亮（照搬参考项目：Sidebar 防抖搜索后传入，2 秒后自动移除） */
  readonly highlighted: boolean;
  readonly onSelect: () => void;
  readonly onDelete: () => void;
  /** 置顶/取消置顶回调（对齐参考项目 pinned-header 分组） */
  readonly onTogglePin: () => void;
  /** 打开会话文件树回调（对齐原型 ti-action-btn data-act=files） */
  readonly onOpenFiles: () => void;
  /** 在资源管理器中打开会话工作目录（shell.openPath） */
  readonly onOpenInExplorer: () => void;
}

export function SortableThreadItem({
  sessionId,
  folderName,
  title,
  updatedAt,
  isActive,
  isDeleting,
  isPinned,
  highlighted,
  onSelect,
  onDelete,
  onTogglePin,
  onOpenFiles,
  onOpenInExplorer,
}: SortableThreadItemProps): ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sessionId,
    data: { folder: folderName },
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform:
          transform === null ? undefined : `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        transition,
      }}
      className={isDragging ? 'opacity-50' : undefined}
    >
      <ThreadItem
        sessionId={sessionId}
        title={title}
        updatedAt={updatedAt}
        isActive={isActive}
        isDeleting={isDeleting}
        isPinned={isPinned}
        highlighted={highlighted}
        onSelect={onSelect}
        onDelete={onDelete}
        onTogglePin={onTogglePin}
        onOpenFiles={onOpenFiles}
        onOpenInExplorer={onOpenInExplorer}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}

// ── 子组件：会话列表项（对齐原型 thread-item 结构） ──────────────

interface ThreadItemProps {
  /** 会话 id（重命名提交用） */
  readonly sessionId: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly isActive: boolean;
  readonly isDeleting: boolean;
  readonly isPinned: boolean;
  /** 搜索匹配高亮（照搬参考项目：Sidebar 防抖搜索后传入，2 秒后自动移除） */
  readonly highlighted: boolean;
  readonly onSelect: () => void;
  readonly onDelete: () => void;
  /** 置顶/取消置顶回调（对齐参考项目 pinned-header 分组） */
  readonly onTogglePin: () => void;
  /** 打开会话文件树回调（对齐原型 ti-action-btn data-act=files） */
  readonly onOpenFiles: () => void;
  /** 在资源管理器中打开会话工作目录（shell.openPath） */
  readonly onOpenInExplorer: () => void;
  /** 拖拽手柄属性（@dnd-kit useSortable 的 attributes + listeners，挂在 ti-dot 上） */
  readonly dragHandleProps?: Record<string, unknown>;
}

/** 会话列表项 - 对齐原型 .thread-item 结构 */
function ThreadItem({
  sessionId,
  title,
  updatedAt,
  isActive,
  isDeleting,
  isPinned,
  highlighted,
  onSelect,
  onDelete,
  onTogglePin,
  onOpenFiles,
  onOpenInExplorer,
  dragHandleProps,
}: ThreadItemProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 内联重命名状态（双击标题或更多菜单触发；对齐参考项目 ThreadItem 内联重命名）
  const [renaming, setRenaming] = useState(false);
  // 重命名提交（useRenameSession：mutation + invalidate 自动刷新列表）
  const { mutateAsync: renameSession } = useRenameSession();

  /** 提交重命名：空值/未变化时直接退出编辑态 */
  const commitRename = (next: string): void => {
    const trimmed = next.trim();
    setRenaming(false);
    if (trimmed.length === 0 || trimmed === title) {
      return;
    }
    void renameSession({ id: sessionId, title: trimmed });
  };
  // 元信息：仅时间（用户要求——不显示消息预览）
  const metaText = formatRelativeTime(updatedAt, t);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          className={cn(
            'thread-item',
            isActive && 'active',
            // I-S-001: 搜索防抖后匹配项添加临时高亮环（2 秒后由 Sidebar 清除）
            highlighted && 'ring-1 ring-[var(--accent)]/40',
          )}
          onClick={onSelect}
          onDoubleClick={() => setRenaming(true)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelect();
            }
          }}
          aria-current={isActive ? 'page' : undefined}
        >
          <div className="ti-row">
            {/* ti-dot：拖拽手柄（dnd-kit），hover 显示抓取光标；不参与点击选择（title 提供可访问说明） */}
            <span
              className="ti-dot cursor-grab active:cursor-grabbing"
              title={t('sidebar.dragSort')}
              {...dragHandleProps}
            />
            <div className="ti-content">
              {renaming ? (
                // 内联重命名输入框（uncontrolled + key：切换标题时重置 defaultValue）
                <input
                  key={`rename-${title}`}
                  type="text"
                  defaultValue={title}
                  // biome-ignore lint/a11y/noAutofocus: 内联重命名需要即时聚焦（对齐参考项目编辑模式）
                  autoFocus
                  className="bg-background border-border text-foreground w-full rounded border px-1 py-0.5 text-xs"
                  aria-label={t('sidebar.renameTitle')}
                  onBlur={(event) => {
                    void commitRename(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void commitRename(event.currentTarget.value);
                    } else if (event.key === 'Escape') {
                      setRenaming(false);
                    }
                  }}
                />
              ) : (
                <div className="ti-title" title={`${title}（${t('sidebar.doubleClickRename')}）`}>
                  {title}
                </div>
              )}
              <div className="ti-meta">{metaText}</div>
            </div>
            {/* 重命名中隐藏操作按钮：给输入框让出整行宽度（此前 97px 挤在 52px 操作按钮旁） */}
            <div className={cn('ti-actions', renaming && 'hidden')}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:bg-sidebar-accent-foreground/10 hover:text-sidebar-foreground size-6"
                    aria-label={t('sidebar.sessionActions')}
                    disabled={isDeleting}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <MoreVertical className="size-3.5" strokeWidth={1.5} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => {
                      onTogglePin();
                    }}
                  >
                    <Pin className="size-3.5" strokeWidth={1.5} />
                    {isPinned ? t('sidebar.unpin') : t('sidebar.pin')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      onOpenInExplorer();
                    }}
                  >
                    <FolderOpen className="size-3.5" strokeWidth={1.5} />
                    {t('sidebar.openInExplorer')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      onOpenFiles();
                    }}
                  >
                    <FolderTree className="size-3.5" strokeWidth={1.5} />
                    {t('sidebar.fileManager')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      setRenaming(true);
                    }}
                  >
                    <Pencil className="size-3.5" strokeWidth={1.5} />
                    {t('sidebar.rename')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      onDelete();
                    }}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="size-3.5" strokeWidth={1.5} />
                    {t('sidebar.deleteSession')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {/* 文件树按钮（会话操作之后——用户要求的顺序：操作菜单在左，文件树在右） */}
              <button
                type="button"
                // 与左侧更多菜单按钮同款工具类样式（此前 .ti-action-btn 无任何 CSS 规则，裸奔渲染）
                className="text-muted-foreground hover:bg-sidebar-accent-foreground/10 hover:text-sidebar-foreground flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-50"
                aria-label={t('sidebar.openFiles')}
                title={t('sidebar.openFiles')}
                disabled={isDeleting}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenFiles();
                }}
              >
                <FolderTree className="size-3.5" strokeWidth={1.5} />
              </button>
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onTogglePin()}>
          <Pin className="size-3.5" strokeWidth={1.5} />
          {isPinned ? t('sidebar.unpin') : t('sidebar.pin')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onOpenInExplorer()}>
          <FolderOpen className="size-3.5" strokeWidth={1.5} />
          {t('sidebar.openInExplorer')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onOpenFiles()}>
          <FolderTree className="size-3.5" strokeWidth={1.5} />
          {t('sidebar.fileManager')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => setRenaming(true)}>
          <Pencil className="size-3.5" strokeWidth={1.5} />
          {t('sidebar.rename')}
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => onDelete()}>
          <Trash2 className="size-3.5" strokeWidth={1.5} />
          {t('sidebar.deleteSession')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ── 子组件：加载中 / 空状态 ───────────────────────────────────

/** 加载中骨架屏（5 行占位） */
