import type {
  AgentStreamEndPayload,
  AgentStreamErrorPayload,
  AgentStreamStartPayload,
} from '@code-agent/shared/renderer';
import type { InfiniteData } from '@tanstack/react-query';
import { useEffect } from 'react';

import {
  SESSION_DETAIL_QUERY_KEY,
  SESSIONS_QUERY_KEY,
  type SessionListData,
} from '@/hooks/use-sessions';
import { isTurnEndCovered } from '@/lib/invalidation/invalidation';
import { hasIpcBridge } from '@/lib/ipc';
import { GOAL_LIST_QUERY_KEY, QUERY_KEY_ROOTS } from '@/lib/query/keys';
import { queryClient } from '@/lib/query/query-client';
import { useAgentAskStore } from '@/stores/transient/agent-ask-store';
import { useApprovalsStore } from '@/stores/transient/approvals-store';
import { useRateLimitStore } from '@/stores/transient/rate-limit-store';
import { useTurnErrorStore } from '@/stores/transient/turn-error-store';

/**
 * 把指定会话的 lastRunStatus 乐观点亮为 running（D4A：回合开始 → 侧栏运行徽标）
 *
 * 选 setQueryData 而非 invalidate sessions（两种成熟方案的取舍）：
 * - 主进程 markRunning 是 fire-and-forget 落库，invalidate 触发的重拉存在
 *   读不到 running 的时序竞态（徽标闪失）；setQueryData 直接改缓存，确定生效；
 * - 回合开始是高频事件，免去整列表重拉的 IPC 与渲染成本；
 * - 回合结束已有 handleSessionEnd 的 invalidate 统一收敛为服务端真值。
 * 会话不在缓存（如新会话首轮回合、列表尚未刷新）时映射无命中，等下次列表刷新自然带上。
 */
function applyRunningToCache(
  old: InfiniteData<SessionListData> | undefined,
  sessionId: string,
): InfiniteData<SessionListData> | undefined {
  if (old === undefined) return old;
  return {
    ...old,
    pages: old.pages.map((page) => ({
      ...page,
      sessions: page.sessions.map((s) =>
        s.id === sessionId ? { ...s, lastRunStatus: 'running' as const } : s,
      ),
    })),
  };
}

/**
 * Agent 回合结束统一处理（invalidate 缓存 + 清理 L2 缓冲）
 *
 * 失效（1）走渐进回落：主进程回合结束已先广播 invalidation:event:domains
 * （agent-service.completeTurn 的聚合声明，use-invalidation-bridge 消费并登记覆盖），
 * 本处仅在事件缺失（覆盖未登记）时回落旧硬编码清单。L2 清理（2）不属于缓存
 * 失效域，事件不覆盖，保持无条件执行。
 */
function handleSessionEnd(sessionId: string): void {
  if (!isTurnEndCovered(sessionId)) {
    void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    if (sessionId.length > 0) {
      void queryClient.invalidateQueries({ queryKey: SESSION_DETAIL_QUERY_KEY(sessionId) });
      void queryClient.invalidateQueries({ queryKey: GOAL_LIST_QUERY_KEY(sessionId) });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY_ROOTS.task });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY_ROOTS.usage });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY_ROOTS.git });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY_ROOTS.file });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY_ROOTS.turns });
    }
  }

  useApprovalsStore.getState().clearBySession(sessionId);
  useAgentAskStore.getState().clearAsk(sessionId);
}

/**
 * Agent 生命周期 IPC 桥接 Hook
 *
 * 在根布局（AppShell）调用一次。
 *
 * @example
 * ```tsx
 * function AppShell() {
 *   useAgentBridge();
 *   // ...
 * }
 * ```
 */
export function useAgentBridge(): void {
  useEffect(() => {
    if (!hasIpcBridge()) return;

    const unsubscribeStart = window.api.agent.subscribeStreamStart((payload) => {
      const typedPayload = payload as AgentStreamStartPayload;
      useTurnErrorStore.getState().clear(typedPayload.sessionId);
      queryClient.setQueryData<InfiniteData<SessionListData>>(SESSIONS_QUERY_KEY, (old) =>
        applyRunningToCache(old, typedPayload.sessionId),
      );
    });

    const unsubscribeEnd = window.api.agent.subscribeStreamEnd((payload) => {
      const typedPayload = payload as AgentStreamEndPayload;
      handleSessionEnd(typedPayload.sessionId);
    });

    const unsubscribeError = window.api.agent.subscribeStreamError((payload) => {
      const typedPayload = payload as AgentStreamErrorPayload;
      handleSessionEnd(typedPayload.sessionId);
      useTurnErrorStore
        .getState()
        .set(typedPayload.sessionId, typedPayload.code, typedPayload.message);
      if (typedPayload.code === 'AI_RATE_LIMITED') {
        useRateLimitStore.getState().trigger();
      }
    });

    return () => {
      unsubscribeStart();
      unsubscribeEnd();
      unsubscribeError();
    };
  }, []);
}
