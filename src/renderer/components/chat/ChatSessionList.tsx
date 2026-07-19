// src/renderer/components/chat/ChatSessionList.tsx
// 聊天会话列表侧边栏
// 设计文档 §5.1 数据流 + §7.10 用户友好提示
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
      <aside className="bg-card border-r flex w-64 shrink-0 flex-col">
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<MessageSquare className="size-6" />}
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
    <aside className="bg-card border-r flex w-64 shrink-0 flex-col">
      {/* 顶部标题 + 新建按钮 */}
      <div className="flex items-center justify-between gap-2 border-b p-3">
        <h2 className="text-foreground text-sm font-semibold">会话列表</h2>
        <Button variant="outline" size="sm" onClick={onCreateClick}>
          <Plus className="size-4" />
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
                    'group flex cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-sm transition-colors',
                    'hover:bg-accent hover:text-accent-foreground',
                    'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
                    isActive && 'bg-accent text-accent-foreground font-medium',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{session.title}</p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
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
                        <MoreVertical className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteSession(session.id);
                        }}
                      >
                        <Trash2 className="size-4" />
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
