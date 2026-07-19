// src/renderer/hooks/use-chat-sessions.ts
// 聊天会话领域 hooks
// 设计文档 §5.1 数据流 + §6.2 ChatSession 模型
//
// 职责：
// - useChatSessionList：按 projectId 获取会话列表
// - useCreateChatSession：新建会话
// - useDeleteChatSession：删除会话（主进程级联删除消息 + 中断活跃流）

import type { ChatSession, ChatSessionCreateInput } from '@novel-writer/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient, unwrap } from '@/api/client';
import { queryKeys } from '@/api/query-keys';

/**
 * 获取会话列表
 *
 * @param projectId - 项目 ID（为 falsy 时不启用查询）
 */
export function useChatSessionList(projectId: string | null | undefined) {
  const safeId = projectId ?? '';
  return useQuery({
    queryKey: queryKeys.chatSessions.list(safeId),
    queryFn: async () =>
      unwrap<ChatSession[]>(await apiClient.chat.listSessions({ projectId: safeId })),
    enabled: projectId !== undefined && projectId !== null && projectId.length > 0,
  });
}

/**
 * 新建聊天会话
 *
 * 成功后失效会话列表缓存。
 */
export function useCreateChatSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ChatSessionCreateInput) =>
      unwrap<ChatSession>(await apiClient.chat.createSession(input)),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKeys.chatSessions.list(data.projectId) });
    },
  });
}

/**
 * 发送聊天消息（非流式调用，仅触发主进程 ack；流式 chunk 通过 useChatMessages 订阅）
 *
 * 成功后失效该会话的消息列表缓存（让 list 重新加载历史消息）。
 */
export function useSendChatMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { sessionId: string; content: string }) =>
      unwrap<{ ackId: string }>(await apiClient.chat.sendMessage(input)),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: queryKeys.chatMessages.list(vars.sessionId) });
    },
  });
}

/**
 * 停止流式生成
 *
 * 调用后主进程会停止追加 chunk 并发送 chat:stream:end 事件。
 */
export function useStopChatGeneration() {
  return useMutation({
    mutationFn: async (sessionId: string) =>
      unwrap<{ stopped: boolean }>(await apiClient.chat.stopGeneration({ sessionId })),
  });
}

/**
 * 删除聊天会话
 *
 * 调用主进程 chat:deleteSession，主进程内部会：
 * 1. 校验会话存在
 * 2. 若有活跃 AI 流则先 abort
 * 3. prisma.chatSession.delete 级联删除所有消息（schema onDelete: Cascade）
 *
 * 成功后：
 * - 失效该项目下会话列表缓存（让列表刷新）
 * - 移除该会话的消息列表缓存（避免显示陈旧数据）
 *
 * @param projectId 会话所属项目 ID（用于失效会话列表缓存）
 */
export function useDeleteChatSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; projectId: string }) =>
      unwrap<{ id: string }>(await apiClient.chat.deleteSession({ id: input.id })),
    onSuccess: (_data, vars) => {
      // 失效会话列表（让列表重新加载，删除的会话自动消失）
      void qc.invalidateQueries({ queryKey: queryKeys.chatSessions.list(vars.projectId) });
      // 移除该会话的消息缓存（已删除，无需保留）
      void qc.removeQueries({ queryKey: queryKeys.chatMessages.list(vars.id) });
    },
  });
}
