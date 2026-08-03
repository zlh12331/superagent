// src/renderer/hooks/use-agent-bridge.ts
// Agent 生命周期 IPC 桥接 Hook（回合结束的统一消费端）
// ──────────────────────────────────────────────────────────────
// 职责（对齐参考设计的状态分层原则）：
// 1. 回合结束（stream:end）→ invalidate 会话列表 + 详情缓存（L3 模式 B）
//    - 修正"回合结束但会话详情缓存仍是旧数据"的正确性问题
// 2. 回合结束 → 清理 L2 流式缓冲（tool-store / approvals-store clearBySession）
//    - 对齐"turn_done 清空流式缓冲"原则，防止长会话内存累积
// 3. 回合结束（completed）→ token 用量写入 usage-store（per-session 累积）
//    - 对齐参考设计 usage 累积放 store action
//
// 设计：
// - 在 AppShell 根布局初始化一次（与 useToolBridge 相同的桥接模式）
// - 全局订阅（不按 sessionId 过滤）：任何会话回合结束都触发统一处理
// - 不处理 UI 展示（由 ChatPanel 等组件订阅 store 渲染）
// ──────────────────────────────────────────────────────────────

import type { AgentStreamEndPayload, AgentStreamErrorPayload } from '@code-agent/shared/renderer';
import { useEffect } from 'react';

import { SESSION_DETAIL_QUERY_KEY, SESSIONS_QUERY_KEY } from '@/hooks/use-sessions';
import { queryClient } from '@/lib/query/query-client';
import { useApprovalsStore } from '@/stores/transient/approvals-store';
import { useToolStore } from '@/stores/transient/tool-store';
import { useUsageStore } from '@/stores/transient/usage-store';

/**
 * Agent 回合结束统一处理（invalidate 缓存 + 清理 L2 缓冲 + usage 累积）
 */
function handleSessionEnd(sessionId: string, usage?: AgentStreamEndPayload['usage']): void {
  // 1. L3 模式 B：失效会话列表 + 详情缓存（回合结束后重新拉取）
  void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
  if (sessionId.length > 0) {
    void queryClient.invalidateQueries({ queryKey: SESSION_DETAIL_QUERY_KEY(sessionId) });
  }

  // 2. L2 清理：工具调用 + 审批缓冲（对齐 turn_done 清空原则）
  useToolStore.getState().clearBySession(sessionId);
  useApprovalsStore.getState().clearBySession(sessionId);

  // 3. usage 累积（per-session，completed 时携带）
  if (usage !== undefined) {
    useUsageStore.getState().addUsage(sessionId, usage);
  }
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
    if (typeof window === 'undefined' || window.api === undefined) return;

    // 回合正常结束 / 用户中断：invalidate 缓存 + 清理缓冲 + usage 累积
    const unsubscribeEnd = window.api.agent.subscribeStreamEnd((payload) => {
      const typedPayload = payload as AgentStreamEndPayload;
      handleSessionEnd(typedPayload.sessionId, typedPayload.usage);
    });

    // 回合异常结束：同样 invalidate + 清理（错误可能已部分落库）
    const unsubscribeError = window.api.agent.subscribeStreamError((payload) => {
      const typedPayload = payload as AgentStreamErrorPayload;
      handleSessionEnd(typedPayload.sessionId);
    });

    return () => {
      unsubscribeEnd();
      unsubscribeError();
    };
  }, []);
}
