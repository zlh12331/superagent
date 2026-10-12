import { useSortable } from '@dnd-kit/sortable';
import {
  FolderOpen,
  FolderTree,
  Hourglass,
  Loader2,
  MoreVertical,
  Pencil,
  Pin,
  Trash2,
} from 'lucide-react';
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
  readonly updatedAt: number;
  readonly isActive: boolean;
  readonly isDeleting: boolean;
  readonly isPinned: boolean;
  /** 会话有回合在跑（lastRunStatus='running'，D4A：渲染运行徽标） */
  readonly isRunning: boolean;
  /**
   * 会话有等待用户决策的审批（2026-10-08：跨会话可见性）
   *
   * 数据源 = approvals-store.pending 按 sessionId 聚合。非当前会话的审批请求
   * 只在它自己的 ChatPanel 里渲染，切走后用户无从得知——不响应即 5 分钟超时
   * 被拒。侧栏徽标补上这个可见性缺口（点该行即可切过去处理）。
   */
  readonly hasPendingApproval: boolean;
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

/** 可排序会话条目（dnd-kit）：选中/置顶/删除/打开文件树/资源管理器打开 */
export function SortableThreadItem({
  sessionId,
  folderName,
  title,
  updatedAt,
  isActive,
  isDeleting,
  isPinned,
  isRunning,
  hasPendingApproval,
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
        isRunning={isRunning}
        hasPendingApproval={hasPendingApproval}
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

interface ThreadItemProps {
  /** 会话 id（重命名提交用） */
  readonly sessionId: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly isActive: boolean;
  readonly isDeleting: boolean;
  readonly isPinned: boolean;
  /** 会话有回合在跑（D4A：渲染运行徽标） */
  readonly isRunning: boolean;
  /** 会话有等待用户决策的审批（跨会话可见性：切走后仍能看到并点过去处理） */
  readonly hasPendingApproval: boolean;
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
  isRunning,
  hasPendingApproval,
  highlighted,
  onSelect,
  onDelete,
  onTogglePin,
  onOpenFiles,
  onOpenInExplorer,
  dragHandleProps,
}: ThreadItemProps): ReactElement {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
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
  const metaText = formatRelativeTime(updatedAt, t);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'thread-item',
            isActive && 'active',
            highlighted && 'ring-1 ring-accent/40',
          )}
          aria-current={isActive ? 'page' : undefined}
        >
          <div className="ti-row">
            <span
              className="ti-dot cursor-grab active:cursor-grabbing"
              title={t('sidebar.dragSort')}
              {...dragHandleProps}
            />
            {/* biome-ignore lint/a11y/useSemanticElements: 标题区含块级 div（ti-title/ti-meta），HTML button 内容模型不允许 div；用可聚焦 role=button 的 div，自身无嵌套可聚焦子（elm ti-content 内子元素非可聚焦） */}
            <div
              role="button"
              tabIndex={0}
              className="ti-content"
              onClick={onSelect}
              onDoubleClick={() => setRenaming(true)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect();
                }
              }}
            >
              {renaming ? (
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
                  {isRunning && (
                    <>
                      <Loader2
                        className="text-accent-text mr-1 inline size-2.5 shrink-0 animate-spin"
                        strokeWidth={2.5}
                        aria-hidden="true"
                      />
                      <span className="sr-only">{t('sidebar.sessionRunning')}</span>
                    </>
                  )}
                  {hasPendingApproval && (
                    <>
                      <Hourglass
                        className="text-warn-text mr-1 inline size-2.5 shrink-0"
                        strokeWidth={2.5}
                        aria-hidden="true"
                      />
                      <span className="sr-only">{t('sidebar.sessionPendingApproval')}</span>
                    </>
                  )}
                  {isPinned && (
                    <Pin
                      className="text-accent mr-1 inline size-2.5 shrink-0 -translate-y-px"
                      strokeWidth={2.5}
                      fill="currentColor"
                    />
                  )}
                  {title}
                </div>
              )}
              <div className="ti-meta">{metaText}</div>
            </div>
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
                    className="text-error-text focus:text-error-text"
                  >
                    <Trash2 className="size-3.5" strokeWidth={1.5} />
                    {t('sidebar.deleteSession')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:bg-sidebar-accent-foreground/10 hover:text-sidebar-foreground size-6 shrink-0"
                aria-label={t('sidebar.openFiles')}
                title={t('sidebar.openFiles')}
                disabled={isDeleting}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenFiles();
                }}
              >
                <FolderTree className="size-3.5" strokeWidth={1.5} />
              </Button>
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
