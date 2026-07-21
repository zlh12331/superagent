// src/renderer/components/layout/Sidebar.tsx
// 侧边栏 · 会话列表 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 职责：
// - 顶部「新对话」按钮：清空激活会话 + 跳转首页
// - 中间会话列表：拉取 SQLite 数据，点击跳转 /chat/:sessionId
// - 每项悬停显示「删除」按钮，调用 deleteSession mutation
// - 加载中展示 Skeleton 占位，空列表展示提示文案
//
// 设计：
// - 状态分层（符合项目规范）：
//   * L2 Zustand：useActiveSessionStore 维护激活会话 id（UI 状态）
//   * L3 TanStack Query：useSessionsQuery 拉取列表（服务端请求状态）
//   * L3 TanStack Mutation：useDeleteSession（自动 invalidate 缓存）
// - 路由跳转通过 react-router useNavigate
// - 激活态通过对比 activeSessionId 与 item.id 手动应用样式
//   （不使用 NavLink，因为需要在点击时额外调用 setActiveSession）
//
// 文学风细节：
// - 衬线字体展示会话标题与时间
// - 选中项用 bg-sidebar-accent 强调
// - 描述文字 muted-foreground
// - 删除按钮 hover 时显现，避免常态干扰
// ──────────────────────────────────────────────────────────────

import { MoreVertical, Plus, Trash2 } from 'lucide-react';
import { type ReactElement, useMemo } from 'react';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useDeleteSession, useSessionsQuery } from '@/hooks/use-sessions';
import { ROUTES, SIDEBAR_WIDTH } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';

/** 相对时间格式化（如「刚刚」「3 分钟前」「昨天」），超过一周显示日期 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;

  // 超过一周显示 YYYY-MM-DD
  return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * 侧边栏
 *
 * 通过 useSessionsQuery 拉取会话列表，useActiveSessionStore 维护激活态。
 * 点击会话项 → navigate 到 /chat/:sessionId + setActiveSession。
 * 点击「新对话」→ clearActiveSession + navigate 到首页。
 *
 * @example
 * ```tsx
 * <AppShell>
 *   <Sidebar />
 *   <main>{children}</main>
 * </AppShell>
 * ```
 */
export function Sidebar(): ReactElement {
  const navigate = useNavigate();

  // L3 TanStack Query：会话列表数据
  const { data, isLoading, error } = useSessionsQuery();
  // L3 TanStack Mutation：删除会话
  const { mutate: deleteSession, isPending: isDeleting } = useDeleteSession();
  // L2 Zustand：激活会话 id（用于高亮当前选中项）
  const activeSessionId = useActiveSessionStore((state) => state.activeSessionId);
  const setActiveSession = useActiveSessionStore((state) => state.setActiveSession);
  const clearActiveSession = useActiveSessionStore((state) => state.clearActiveSession);

  // 派生：会话列表（默认空数组，避免 data 为 undefined 时报错）
  const sessions = useMemo(() => data?.sessions ?? [], [data]);

  // 点击「新对话」：清空激活会话 + 跳转首页
  const handleNewChat = (): void => {
    clearActiveSession();
    navigate(ROUTES.home);
  };

  // 点击会话项：设置激活 + 跳转聊天页
  const handleSelectSession = (sessionId: string): void => {
    setActiveSession(sessionId);
    navigate(ROUTES.chatPath(sessionId));
  };

  // 点击删除：调用 mutation，成功后由 useDeleteSession 自动 invalidate 缓存
  // 若删除的是当前激活会话，额外清空激活态并跳转首页
  const handleDelete = (sessionId: string): void => {
    deleteSession(sessionId, {
      onSuccess: () => {
        if (sessionId === activeSessionId) {
          clearActiveSession();
          navigate(ROUTES.home);
        }
      },
    });
  };

  return (
    <aside
      className="bg-sidebar border-sidebar-border flex flex-col border-r"
      style={{ width: SIDEBAR_WIDTH }}
    >
      {/* 顶部：新对话按钮 */}
      <div className="border-sidebar-border p-3">
        <Button
          variant="outline"
          className="border-sidebar-border hover:bg-sidebar-accent hover:text-sidebar-accent-foreground w-full justify-start gap-2 font-serif tracking-wide"
          onClick={handleNewChat}
        >
          <Plus className="size-4" strokeWidth={1.5} />
          新对话
        </Button>
      </div>

      {/* 中间：会话列表（可滚动） */}
      <ScrollArea className="min-h-0 flex-1">
        <nav className="p-2" aria-label="会话列表">
          {isLoading ? (
            <LoadingList />
          ) : error !== null ? (
            <ErrorHint message={error instanceof Error ? error.message : String(error)} />
          ) : sessions.length === 0 ? (
            <EmptyHint />
          ) : (
            <ul className="flex flex-col gap-0.5">
              {sessions.map((session) => (
                <li key={session.id}>
                  <SessionItem
                    title={session.title}
                    lastMessage={session.lastMessage}
                    updatedAt={session.updatedAt}
                    isActive={session.id === activeSessionId}
                    isDeleting={isDeleting}
                    onSelect={() => handleSelectSession(session.id)}
                    onDelete={() => handleDelete(session.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </nav>
      </ScrollArea>
    </aside>
  );
}

// ── 子组件：会话列表项 ──────────────────────────────────────────

interface SessionItemProps {
  readonly title: string;
  // exactOptionalPropertyTypes：可选属性不允许显式 undefined
  // 此处 lastMessage 可能从 session.lastMessage 直接传入（类型为 string | undefined）
  readonly lastMessage: string | undefined;
  readonly updatedAt: number;
  readonly isActive: boolean;
  readonly isDeleting: boolean;
  readonly onSelect: () => void;
  readonly onDelete: () => void;
}

/**
 * 会话列表项
 *
 * 使用 group + group-hover 控制删除按钮的显隐：
 * - 默认隐藏（focus-within 也可访问，键盘可达）
 * - 悬停整个 li 时显现
 *
 * 激活态通过 isActive prop 手动控制（而非 NavLink 的 .active 类），
 * 因为需要在点击时额外调用 setActiveSession。
 */
function SessionItem({
  title,
  lastMessage,
  updatedAt,
  isActive,
  isDeleting,
  onSelect,
  onDelete,
}: SessionItemProps): ReactElement {
  return (
    // biome-ignore lint/a11y/useSemanticElements: 外层含 DropdownMenu 触发器（button），HTML 禁止 button 嵌套
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'group focus-within:bg-sidebar-accent relative flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-left transition-colors',
        'hover:bg-sidebar-accent',
        isActive && 'bg-sidebar-accent',
      )}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      aria-current={isActive ? 'page' : undefined}
    >
      {/* 左侧：标题 + 预览 + 时间 */}
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'text-sidebar-foreground truncate font-serif text-sm tracking-wide',
            isActive && 'font-semibold',
          )}
        >
          {title}
        </div>
        {lastMessage !== undefined && lastMessage.length > 0 && (
          <div className="text-muted-foreground mt-0.5 truncate text-xs">{lastMessage}</div>
        )}
        <div className="text-muted-foreground/70 mt-1 text-[10px]">
          {formatRelativeTime(updatedAt)}
        </div>
      </div>

      {/* 右侧：操作菜单（hover 时显现） */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:bg-sidebar-accent-foreground/10 hover:text-sidebar-foreground h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            aria-label="会话操作"
            disabled={isDeleting}
            // 阻止点击按钮触发外层 li 的 onSelect
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
  );
}

// ── 子组件：加载中 / 空状态 / 错误状态 ─────────────────────────

/** 加载中骨架屏（5 行占位） */
function LoadingList(): ReactElement {
  return (
    <ul className="flex flex-col gap-1 p-1">
      {Array.from({ length: 5 }).map((_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 静态骨架屏占位，index 稳定且无重排
        <li key={index} className="px-2 py-2">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="mt-2 h-2 w-1/2" />
        </li>
      ))}
    </ul>
  );
}

/** 空状态提示 */
function EmptyHint(): ReactElement {
  return (
    <div className="text-muted-foreground p-6 text-center">
      <p className="font-serif text-sm tracking-wide">尚无会话</p>
      <p className="mt-1 text-xs">点击上方「新对话」开始</p>
    </div>
  );
}

/** 错误状态提示 */
function ErrorHint({ message }: { readonly message: string }): ReactElement {
  return (
    <div className="text-destructive p-4 text-center">
      <p className="font-serif text-sm">会话列表加载失败</p>
      <p className="mt-1 truncate text-xs" title={message}>
        {message}
      </p>
    </div>
  );
}
