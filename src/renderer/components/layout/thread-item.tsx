// src/renderer/components/layout/thread-item.tsx
// 侧边栏 · 会话线程项（可拖拽 + 内联重命名 + 操作菜单）
// ──────────────────────────────
// 拆分背景（2026-08 重构）：自 Sidebar 641 行按职责提取。
// 结构：
// - SortableThreadItem：@dnd-kit useSortable 包装（拖拽句柄属性 + 位移样式）
// - ThreadItem：纯展示行（标题/相对时间/操作菜单/上下文菜单/内联重命名）
//
// 说明：元信息只显示相对时间，**不显示消息预览**（用户要求）——
// 故本组件不接收 lastMessage，勿再加回。
// ──────────────────────────────

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
        {/* 会话行：外层为定位/样式容器（普通 div，非可聚焦），交互由各自控件承载，
            避免外层 role=button 包裹内部按钮造成嵌套交互（axe nested-interactive） */}
        <div
          className={cn(
            'thread-item',
            isActive && 'active',
            // I-S-001: 搜索防抖后匹配项添加临时高亮环（2 秒后由 Sidebar 清除）
            highlighted && 'ring-1 ring-accent/40',
          )}
          aria-current={isActive ? 'page' : undefined}
        >
          <div className="ti-row">
            {/* ti-dot：拖拽手柄（dnd-kit），独立可聚焦，不含选择交互（title 提供可访问说明） */}
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
                  {/* 置顶标识（用户要求：置顶/未置顶有明显区别） */}
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
                    className="text-error-text focus:text-error-text"
                  >
                    <Trash2 className="size-3.5" strokeWidth={1.5} />
                    {t('sidebar.deleteSession')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {/* 文件树按钮（会话操作之后——用户要求的顺序：操作菜单在左，文件树在右） */}
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
