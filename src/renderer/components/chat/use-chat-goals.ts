import type { GoalInfo } from '@code-agent/shared/renderer';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useMutationOnError } from '@/hooks/use-mutation-error';
import { unwrap } from '@/lib/ipc';
import { GOAL_LIST_QUERY_KEY } from '@/lib/query/keys';

/** 目标栏展示形态（供 GoalBar 组件消费） */
export interface ChatGoalView {
  readonly condition: string;
  readonly status: 'active' | 'completed' | 'aborted';
}

/** 会话目标 hook 返回：展示态（currentGoal/isGoalCompleted）+ 增删动作 */
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
    queryKey: GOAL_LIST_QUERY_KEY(chatId),
    queryFn: async () => {
      try {
        return unwrap(await window.api.goal.list({ sessionId: chatId }));
      } catch {
        return { goals: [] as readonly GoalInfo[] };
      }
    },
  });
  const goals = goalsQuery.data?.goals ?? [];

  const onError = useMutationOnError();

  const createGoalMutation = useMutation({
    mutationFn: async (condition: string) => {
      unwrap(await window.api.goal.create({ sessionId: chatId, condition }));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: GOAL_LIST_QUERY_KEY(chatId) });
    },
    onError,
  });

  const clearGoalMutation = useMutation({
    mutationFn: async () => {
      unwrap(await window.api.goal.clear({ sessionId: chatId }));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: GOAL_LIST_QUERY_KEY(chatId) });
    },
    onError,
  });

  const currentGoal: ChatGoalView | undefined = goals.find(
    (g) => g.status === 'active' || g.status === 'completed',
  );

  return {
    currentGoal,
    isGoalCompleted: currentGoal?.status === 'completed',
    createGoal: (condition) => createGoalMutation.mutate(condition),
    clearGoal: () => clearGoalMutation.mutate(),
  };
}
