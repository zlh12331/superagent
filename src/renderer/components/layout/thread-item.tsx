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
import { MoreVertical, Trash2 } from 'lucide-react';
import type { ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
          <div className="ti-title" title={title}>
            {title}
          </div>
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
                  onDelete();
                }}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="size-3.5" strokeWidth={1.5} />
                删除会话
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
