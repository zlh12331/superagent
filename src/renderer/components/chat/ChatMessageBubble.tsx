// src/renderer/components/chat/ChatMessageBubble.tsx
// 单条聊天消息气泡
// 设计文档 §5.1 场景 3 AI 流式对话 + §7.10 用户友好提示
//
// 职责：
// - 根据 role 选择气泡对齐方式与背景色
// - 显示消息内容（whitespace-pre-wrap 保留换行）
// - 流式时（isStreaming=true）在末尾显示闪烁光标
// - 显示头像、时间、tokens（仅 assistant 且非流式时显示 tokens）
//
// 注意：
// - role=system 用居中小字风格，区分 user/assistant
// - 流式光标用 Tailwind animate-pulse + "▌" 字符简化实现，无需额外 CSS
// - role 是字面量联合类型，可直接 if/else 分支，无需 Map

import type { ChatMessage } from '@novel-writer/shared';
import type { ReactElement } from 'react';

import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';

interface ChatMessageBubbleProps {
  /** 当前消息数据 */
  message: ChatMessage;
  /**
   * 是否为流式追加的临时气泡（默认 false）
   * true 时在内容末尾显示闪烁光标，且不显示 tokens 与时间
   */
  isStreaming?: boolean;
}

/** 角色头像文案映射 */
const AVATAR_TEXT: Record<ChatMessage['role'], string> = {
  user: '我',
  assistant: 'AI',
  system: '系统',
};

/**
 * 单条聊天消息气泡
 *
 * @example
 * <ChatMessageBubble message={msg} />
 * <ChatMessageBubble message={streamingMsg} isStreaming />
 */
export function ChatMessageBubble({
  message,
  isStreaming = false,
}: ChatMessageBubbleProps): ReactElement {
  const role = message.role;

  // system 消息：居中小字风格，区别于 user/assistant 的气泡布局
  if (role === 'system') {
    return (
      <div className="flex justify-center py-2">
        <div className="bg-amber-500/10 text-amber-700 rounded-full px-3 py-1 text-xs">
          {message.content}
        </div>
      </div>
    );
  }

  // user / assistant：左右对齐的气泡布局
  const isUser = role === 'user';
  return (
    <div className={cn('flex gap-2 py-2', isUser ? 'flex-row-reverse' : 'flex-row')}>
      {/* 头像 */}
      <div
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
        )}
      >
        {AVATAR_TEXT[role]}
      </div>
      {/* 气泡 + 元信息 */}
      <div className={cn('flex max-w-[80%] flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
        <div
          className={cn(
            'whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm',
            isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
          )}
        >
          {message.content}
          {/* 流式光标：闪烁的 ▌ 字符（Tailwind animate-pulse 实现） */}
          {isStreaming && (
            <span className="ml-0.5 inline-block animate-pulse" aria-hidden="true">
              ▌
            </span>
          )}
        </div>
        {/* 元信息：时间 + tokens（仅 assistant 非流式且 tokens>0 时显示 tokens） */}
        {!isStreaming && (
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <span>{formatRelativeTime(message.createdAt)}</span>
            {!isUser && message.tokens > 0 && <span>· {message.tokens} tokens</span>}
          </div>
        )}
      </div>
    </div>
  );
}
