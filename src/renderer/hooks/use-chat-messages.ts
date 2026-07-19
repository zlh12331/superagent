// src/renderer/hooks/use-chat-messages.ts
// 聊天消息领域 hooks + 流式订阅
// 设计文档 §5.1 场景 3 AI 流式对话 + §6.2 ChatMessage 模型
//
// 职责：
// - useChatMessages：按 sessionId 获取历史消息
// - useChatStreamSubscription：订阅 IPC 流式事件（chunk/end/error），写入 chat-stream.store
//
// 注意：流式订阅通过 useEffect 在 ChatMessageList 中调用，
// 生命周期与 sessionId 绑定（切换 session 时重新订阅）。

import type { ChatMessage } from '@novel-writer/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { apiClient, unwrap } from '@/api/client';
import { queryKeys } from '@/api/query-keys';
import { useChatStreamStore } from '@/stores/chat-stream.store';

/**
 * 获取会话历史消息
 *
 * @param sessionId - 会话 ID（为 falsy 时不启用查询）
 */
export function useChatMessages(sessionId: string | null | undefined) {
  const safeId = sessionId ?? '';
  return useQuery({
    queryKey: queryKeys.chatMessages.list(safeId),
    queryFn: async () =>
      unwrap<ChatMessage[]>(await apiClient.chat.getMessages({ sessionId: safeId })),
    enabled: sessionId !== undefined && sessionId !== null && sessionId.length > 0,
  });
}

/**
 * 订阅指定会话的流式事件
 *
 * 在组件 mount 时订阅 onStreamChunk/onStreamEnd/onStreamError，
 * unmount 或 sessionId 变化时自动 cleanup。
 *
 * @param sessionId - 当前订阅的会话 ID（为 null 时不订阅）
 */
export function useChatStreamSubscription(sessionId: string | null): void {
  const appendChunk = useChatStreamStore((s) => s.appendChunk);
  const endStream = useChatStreamStore((s) => s.endStream);
  const errorStream = useChatStreamStore((s) => s.errorStream);
  const setActiveSession = useChatStreamStore((s) => s.setActiveSession);

  useEffect(() => {
    if (sessionId === null) {
      setActiveSession(null);
      return;
    }

    setActiveSession(sessionId);

    // 订阅三类流式事件，返回值均为 cleanup 函数
    const unsubChunk = apiClient.chat.onStreamChunk((payload) => {
      // 仅处理当前 session 的 chunk，避免多 session 串扰
      if (payload.sessionId === sessionId) {
        appendChunk(payload.sessionId, payload.chunk);
      }
    });
    const unsubEnd = apiClient.chat.onStreamEnd((payload) => {
      if (payload.sessionId === sessionId) {
        endStream(payload.sessionId, payload.fullText);
      }
    });
    const unsubError = apiClient.chat.onStreamError((payload) => {
      if (payload.sessionId === sessionId) {
        const message =
          payload.error instanceof Error ? payload.error.message : String(payload.error);
        errorStream(payload.sessionId, message);
      }
    });

    return () => {
      unsubChunk();
      unsubEnd();
      unsubError();
    };
  }, [sessionId, appendChunk, endStream, errorStream, setActiveSession]);
}
