// src/renderer/components/chat/use-chat-goals.ts
// 会话目标（goal）数据与变更（自 ChatPanel 提取的 L3 层 hook）
// ──────────────────────────────────────────────
// 数据源：goal:list / goal:create / goal:list IPC（L3 TanStack Query + Mutation）。
// 展示策略：active 优先，其次 completed（刚完成待确认）；aborted 不展示
// ——避免「删除后目标栏仍在」。
// ──────────────────────────────────────────────

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/** 目标栏展示形态（供 GoalBar 组件消费） */
export interface ChatGoalView {
  readonly condition: string;
  readonly status: 'active' | 'completed' | 'aborted';
}

export interface ChatGoals {
  /** 当前展示目标（active 优先 → completed；无目标为 undefined） */
  readonly currentGoal: ChatGoalView | undefined;
  /** 当前目标是否已完成（GoalBar 显示完成徽标） */
  readonly isGoalCompleted: boolean;
  /** 创建目标（成功后失效 goal:list 缓存） */
  readonly createGoal: (condition: string) => void;
  /** 清除目标（成功后失效 goal:list 缓存） */
  readonly clearGoal: () => void;
}

/**
 * 会话目标 hook
 *
 * @param chatId 会话 id（goals 按会话隔离；undefined 时查询禁用）
 */
export function useChatGoals(chatId: string): ChatGoals {
  const queryClient = useQueryClient();

  const goalsQuery = useQuery({
    queryKey: ['goal', 'list', chatId],
    enabled: chatId !== undefined,
    queryFn: async () => {
      if (chatId === undefined) return { goals: [] as unknown[] };
      const response = await window.api.goal.list({ sessionId: chatId });
      if ('error' in response && response.error !== undefined) {
        return { goals: [] as unknown[] };
      }
      if ('data' in response && response.data !== undefined) {
        return response.data;
      }
      return { goals: [] as unknown[] };
    },
  });
  const goals = (goalsQuery.data?.goals ?? []) as ReadonlyArray<ChatGoalView>;

  const createGoalMutation = useMutation({
    mutationFn: async (condition: string) => {
      if (chatId === undefined) return;
      const response = await window.api.goal.create({ sessionId: chatId, condition });
      if ('error' in response && response.error !== undefined) {
        throw new Error(response.error.message);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['goal', 'list', chatId] });
    },
  });

  const clearGoalMutation = useMutation({
    mutationFn: async () => {
      if (chatId === undefined) return;
      const response = await window.api.goal.clear({ sessionId: chatId });
      if ('error' in response && response.error !== undefined) {
        throw new Error(response.error.message);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['goal', 'list', chatId] });
    },
  });

  // 当前目标：active 优先，其次 completed（可能刚完成待用户确认）；
  // aborted（已清除/被覆盖的旧目标）不展示——避免“删除后目标栏仍在”
  const currentGoal: ChatGoalView | undefined =
    goals.find((g) => g.status === 'active') ?? goals.find((g) => g.status === 'completed');

  return {
    currentGoal,
    isGoalCompleted: currentGoal?.status === 'completed',
    createGoal: (condition) => createGoalMutation.mutate(condition),
    clearGoal: () => clearGoalMutation.mutate(),
  };
}
