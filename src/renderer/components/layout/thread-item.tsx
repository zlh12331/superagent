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
import { MoreVertical, Pencil, Trash2 } from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { Button } from '@/components/ui/button';
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
  readonly onSelect: () => void;
  readonly onDelete: () => void;
}

export function SortableThreadItem({
  sessionId,
  folderName,
  title,
  lastMessage,
  updatedAt,
  isActive,
  isDeleting,
  onSelect,
  onDelete,
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
        lastMessage={lastMessage}
        updatedAt={updatedAt}
        isActive={isActive}
        isDeleting={isDeleting}
        onSelect={onSelect}
        onDelete={onDelete}
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
  readonly lastMessage: string | undefined;
  readonly updatedAt: number;
  readonly isActive: boolean;
  readonly isDeleting: boolean;
  readonly onSelect: () => void;
  readonly onDelete: () => void;
  /** 拖拽手柄属性（@dnd-kit useSortable 的 attributes + listeners，挂在 ti-dot 上） */
  readonly dragHandleProps?: Record<string, unknown>;
}

/** 会话列表项 - 对齐原型 .thread-item 结构 */
function ThreadItem({
  sessionId,
  title,
  lastMessage,
  updatedAt,
  isActive,
  isDeleting,
  onSelect,
  onDelete,
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
  // 元信息：时间 + 预览（取 lastMessage 前 20 字符）
  const metaParts: string[] = [formatRelativeTime(updatedAt, t)];
  if (lastMessage !== undefined && lastMessage.length > 0) {
    const preview = lastMessage.length > 20 ? `${lastMessage.slice(0, 20)}…` : lastMessage;
    metaParts.push(preview);
  }
  const metaText = metaParts.join(' · ');

  return (
    // biome-ignore lint/a11y/useSemanticElements: 外层含 DropdownMenu 触发器（button），HTML 禁止 button 嵌套
    <div
      role="button"
      tabIndex={0}
      className={cn('thread-item', isActive && 'active')}
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
        <div className="ti-actions">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:bg-sidebar-accent-foreground/10 hover:text-sidebar-foreground h-6 w-6"
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
        </div>
      </div>
    </div>
  );
}

// ── 子组件：加载中 / 空状态 ───────────────────────────────────

/** 加载中骨架屏（5 行占位） */
