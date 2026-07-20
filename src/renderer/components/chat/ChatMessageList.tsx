// src/renderer/components/chat/ChatMessageList.tsx
// 聊天消息流容器 · 极简文学风（含流式 chunk 订阅）
// ──────────────────────────────────────────────────────────────
// 设计：
// - 主区域用 paper-texture 纸张纹理
// - 消息容器居中限宽，大留白
// - 图标 strokeWidth=1.5
// ──────────────────────────────────────────────────────────────
//
// 职责：
// - 用 useChatStreamSubscription(sessionId) 订阅 IPC 流式事件（chunk/end/error）
// - 用 useChatStreamStore selector 订阅当前 session 的流式状态（text/status/error）
// - 渲染历史消息 + 流式临时气泡 + 错误状态
// - 自动滚动到底部（messages.length 或 streamText 变化时触发）
// - 流式结束（streaming → completed）时失效消息缓存，触发重新拉取历史消息
//
// 注意：
// - 流式订阅与显示紧耦合，故在组件内部调用 useChatStreamSubscription
// - selector 订阅粒度为单个 session，避免其他 session 更新触发重渲染
// - noUncheckedIndexedAccess 下 Record 索引返回 T | undefined，需 ?? '' 兜底
// - 流式临时气泡的 id 用固定占位 '__streaming__'，仅用于 React key 唯一性

import type { ChatMessage } from '@novel-writer/shared';
import { useQueryClient } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import type { ReactElement } from 'react';
import { useEffect, useRef } from 'react';
import { queryKeys } from '@/api/query-keys';
import { ChatMessageBubble } from '@/components/chat/ChatMessageBubble';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useChatStreamSubscription } from '@/hooks/use-chat-messages';
import type { ChatStreamStatus } from '@/stores/chat-stream.store';
import { useChatStreamStore } from '@/stores/chat-stream.store';

interface ChatMessageListProps {
  /** 当前会话 ID（null 表示未选中会话） */
  sessionId: string | null;
  /** 历史消息列表（已按 createdAt 升序） */
  messages: ChatMessage[];
}

/** 流式临时气泡的固定 ID（仅用于 React key 唯一性，不会写入数据库） */
const STREAMING_BUBBLE_ID = '__streaming__';

/**
 * 聊天消息流容器
 *
 * @example
 * <ChatMessageList sessionId={activeSessionId} messages={messages} />
 */
export function ChatMessageList({ sessionId, messages }: ChatMessageListProps): ReactElement {
  // 订阅当前 session 的流式事件（chunk/end/error 写入 store）
  useChatStreamSubscription(sessionId);

  // 通过 selector 订阅当前 session 的流式状态（避免无关 session 触发重渲染）
  // noUncheckedIndexedAccess 下 Record 索引返回 T | undefined，需兜底
  const streamText = useChatStreamStore((s) =>
    sessionId ? (s.chunksBySession[sessionId] ?? '') : '',
  );
  const streamStatus = useChatStreamStore((s) =>
    sessionId
      ? (s.statusBySession[sessionId] ?? ('completed' as ChatStreamStatus))
      : ('completed' as ChatStreamStatus),
  );
  const streamError = useChatStreamStore((s) =>
    sessionId ? (s.errorBySession[sessionId] ?? '') : '',
  );

  const qc = useQueryClient();
  // 用 ref 保存上一个 streamStatus，用于检测 streaming → completed 转换
  const prevStatusRef = useRef<ChatStreamStatus>('completed');

  /**
   * 流式状态变化副作用：
   * - streaming → completed：失效消息缓存，触发重新拉取（让历史消息包含最终 assistant 回复）
   * - 其他转换：仅更新 ref，不触发副作用
   */
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = streamStatus;
    if (prev === 'streaming' && streamStatus === 'completed' && sessionId) {
      void qc.invalidateQueries({ queryKey: queryKeys.chatMessages.list(sessionId) });
    }
  }, [streamStatus, sessionId, qc]);

  // 底部锚点：用于 scrollIntoView 自动滚动
  const bottomRef = useRef<HTMLDivElement | null>(null);

  /**
   * 自动滚动到底部
   *
   * 依赖 messages.length + streamText，消息数变化或流式文本追加时触发。
   * 这两个变量仅作为触发条件，不在 effect 体内直接读取，
   * 故用 biome-ignore 关闭 useExhaustiveDependencies 检查。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages.length 与 streamText 是滚动触发的依赖，无需在 effect 体内读取
  useEffect(() => {
    const el = bottomRef.current;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages.length, streamText]);

  // 未选中会话：引导用户选择左侧会话
  if (sessionId === null) {
    return (
      <div className="paper-texture bg-background flex flex-1 items-center justify-center">
        <EmptyState
          icon={<MessageSquare className="size-6" strokeWidth={1.5} />}
          title="请选择左侧会话"
          description="从左侧列表选择一个会话开始对话"
        />
      </div>
    );
  }

  // 流式出错：展示错误状态（含 streamError 消息）
  if (streamStatus === 'error') {
    return (
      <div className="paper-texture bg-background flex flex-1 items-center justify-center">
        <ErrorState error={new Error(streamError || 'AI 回复失败，请重试')} />
      </div>
    );
  }

  // 是否显示流式临时气泡：streaming 状态且有累积文本
  const showStreamingBubble = streamStatus === 'streaming' && streamText.length > 0;

  return (
    <ScrollArea className="paper-texture bg-background flex-1">
      {/* 消息容器：居中限宽 + 大留白 */}
      <div className="mx-auto flex max-w-3xl flex-col px-6 py-6">
        {/* 历史消息 */}
        {messages.map((m) => (
          <ChatMessageBubble key={m.id} message={m} />
        ))}
        {/* 流式临时气泡：role=assistant, isStreaming=true */}
        {showStreamingBubble && (
          <ChatMessageBubble
            message={{
              id: STREAMING_BUBBLE_ID,
              sessionId,
              role: 'assistant',
              content: streamText,
              tokens: 0,
              metadata: {},
              createdAt: new Date().toISOString(),
            }}
            isStreaming
          />
        )}
        {/* 底部锚点：自动滚动到此 */}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}
