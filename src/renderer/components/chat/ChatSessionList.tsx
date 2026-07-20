// src/renderer/components/chat/ChatSessionList.tsx
// 聊天会话列表侧边栏 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 设计：
// - 暖米色背景（与 Topbar 同色）
// - 会话项激活态：左侧 3px 墨水条 + 暖米高亮底 + 深棕衬线标题
// - 时间用等宽字体（呼应"墨水计数"感）
// - 标题用衬线字体
// - 图标统一 strokeWidth=1.5
// ──────────────────────────────────────────────────────────────
//
// 职责：
// - 渲染会话列表（标题 + 最后更新时间），高亮当前选中会话
// - 顶部提供"会话列表"标题 + "+ 新建"按钮，触发父组件打开新建对话框
// - 每项右侧 DropdownMenu 提供"删除"操作（destructive）
// - 空会话列表：EmptyState 引导新建第一个会话
//
// 注意：
// - 删除按钮的 DropdownMenu 触发器需 stopPropagation，避免触发会话选中
// - 标题用 truncate 防止溢出
// - updatedAt 用 formatRelativeTime 显示相对时间
// - roleId 用 div + role=button 而非 button，因内部嵌套了 DropdownMenu 触发 Button，
//   HTML 不允许 button 嵌套 button

import type { ChatSession } from '@novel-writer/shared';
import { MessageSquare, MoreVertical, Plus, Trash2 } from 'lucide-react';
import type { ReactElement } from 'react';

import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';

interface ChatSessionListProps {
  /** 当前项目 ID（预留，目前未在组件内直接使用） */
  projectId: string;
  /** 会话列表（已按 updatedAt 倒序） */
  sessions: ChatSession[];
  /** 当前选中会话 ID（null 表示未选中） */
  activeSessionId: string | null;
  /** 选中会话回调 */
  onSelectSession: (id: string) => void;
  /** 点击"新建会话"按钮回调（父组件打开对话框） */
  onCreateClick: () => void;
  /** 删除会话回调（父组件弹出二次确认或直接处理） */
  onDeleteSession: (id: string) => void;
}

/**
 * 聊天会话列表侧边栏
 *
 * @example
 * <ChatSessionList
 *   projectId={projectId}
 *   sessions={sessions}
 *   activeSessionId={activeSessionId}
 *   onSelectSession={setActiveSessionId}
 *   onCreateClick={() => setCreateOpen(true)}
 *   onDeleteSession={(id) => setDeleteTarget(id)}
 * />
 */
export function ChatSessionList({
  projectId: _projectId,
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateClick,
  onDeleteSession,
}: ChatSessionListProps): ReactElement {
  // 空会话列表：引导用户新建第一个会话
  if (sessions.length === 0) {
    return (
      <aside className="bg-sidebar border-sidebar-border flex w-64 shrink-0 flex-col border-r">
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<MessageSquare className="size-6" strokeWidth={1.5} />}
            title="还没有会话"
            description="开始你的第一次 AI 对话"
            actionLabel="新建会话"
            onAction={onCreateClick}
          />
        </div>
      </aside>
    );
  }

  return (
    <aside className="bg-sidebar border-sidebar-border flex w-64 shrink-0 flex-col border-r">
      {/* 顶部标题（衬线）+ 新建按钮 */}
      <div className="border-sidebar-border flex items-center justify-between gap-2 border-b p-3">
        <h2 className="text-foreground font-serif text-sm font-semibold tracking-wide">会话列表</h2>
        <Button variant="outline" size="sm" onClick={onCreateClick}>
          <Plus className="size-4" strokeWidth={1.5} />
          新建
        </Button>
      </div>
      {/* 会话列表：ScrollArea 提供细滚动条 */}
      <ScrollArea className="flex-1">
        <ul className="flex flex-col gap-0.5 p-2">
          {sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            return (
              <li key={session.id}>
                {/* biome-ignore lint/a11y/useSemanticElements: 外层需可点击 + 内含 DropdownMenu 触发 Button，HTML 不允许 button 嵌套 button，故用 div + role=button */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectSession(session.id)}
                  onKeyDown={(e) => {
                    // Enter / Space 触发选中，符合无障碍按钮语义
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectSession(session.id);
                    }
                  }}
                  className={cn(
                    'group relative flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors duration-150',
                    'hover:bg-sidebar-accent',
                    'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
                    // 激活态：暖米高亮 + 深棕文字
                    isActive && 'bg-sidebar-accent text-sidebar-accent-foreground',
                  )}
                >
                  {/* 激活态左侧墨水条（3px 宽，深棕色，垂直居中） */}
                  {isActive && (
                    <span
                      aria-hidden
                      className="bg-primary absolute top-1/2 left-0.5 h-4 w-[3px] -translate-y-1/2 rounded-[1px]"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    {/* 会话标题用衬线字体 */}
                    <p
                      className={cn('truncate font-serif tracking-wide', isActive && 'font-medium')}
                    >
                      {session.title}
                    </p>
                    {/* 时间用等宽字体 */}
                    <p className="text-muted-foreground mt-0.5 font-mono text-[10px] tracking-wider">
                      {formatRelativeTime(session.updatedAt)}
                    </p>
                  </div>
                  {/* 操作菜单：触发器 stopPropagation 避免触发会话选中 */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 opacity-0 group-hover:opacity-100"
                        aria-label="会话操作"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreVertical className="size-3.5" strokeWidth={1.5} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => {
                          // 延迟一帧上抛，避开 DropdownMenu 关闭时派发的 pointerDownOutside 事件
                          // 导致 ConfirmDialog 立即被关闭的问题（详见 ProjectCard.tsx 注释）
                          setTimeout(() => onDeleteSession(session.id), 0);
                        }}
                      >
                        <Trash2 className="size-4" strokeWidth={1.5} />
                        删除
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </aside>
  );
}
