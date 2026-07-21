// src/renderer/hooks/use-active-session.ts
// 激活会话派生 hook（组合 L3 查询 + L2 UI 状态）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 组合 useSessionsQuery（L3 服务端请求状态）+ useActiveSessionStore（L2 UI 状态）
// - 提供业务层一站式 API：当前激活会话对象 + 切换 / 清空操作
// - 屏蔽底层状态分层细节，业务组件无需感知 Zustand / TanStack Query
//
// 设计依据（项目规范）：
// - "Derived state should be implemented with custom hooks
//   (e.g., useActiveSession) to avoid scattered logic in components"
// - activeSessionId 是 UI 状态（Zustand 管理），session 对象是服务端状态（Query 管理）
//   两者组合为派生状态，避免在组件中重复查找逻辑
// ──────────────────────────────────────────────────────────────

import { useMemo } from 'react';

import { useActiveSessionStore } from '@/stores/persistent/sessions-store';

import { useSessionsQuery } from './use-sessions';

/**
 * 激活会话派生 hook
 *
 * 返回当前激活的会话对象（从 sessions 列表中按 activeSessionId 查找），
 * 以及切换 / 清空激活会话的操作。
 *
 * 设计：
 * - sessions 列表来自 TanStack Query（自动缓存 + 失效）
 * - activeSessionId 来自 Zustand（持久化到 localStorage）
 * - 两者通过 useMemo 组合，避免每次 render 都遍历列表
 *
 * @returns 激活会话对象（无激活或未找到时为 null）+ 操作方法
 *
 * @example
 * ```tsx
 * const { activeSession, setActiveSession, clearActiveSession } = useActiveSession();
 *
 * if (activeSession === null) {
 *   return <EmptyState />;
 * }
 * return <div>{activeSession.title}</div>;
 * ```
 */
export function useActiveSession() {
  // L3 服务端请求状态：sessions 列表
  const { data: sessionsData } = useSessionsQuery();

  // L2 UI 状态：激活会话 id + 操作方法
  const activeSessionId = useActiveSessionStore((s) => s.activeSessionId);
  const setActiveSession = useActiveSessionStore((s) => s.setActiveSession);
  const clearActiveSession = useActiveSessionStore((s) => s.clearActiveSession);

  // 派生：从 sessions 列表中查找激活会话对象
  // 若 activeSessionId 为 null 或列表中未找到（可能已被删除），返回 null
  const activeSession = useMemo(() => {
    if (activeSessionId === null || sessionsData === undefined) {
      return null;
    }
    return sessionsData.sessions.find((s) => s.id === activeSessionId) ?? null;
  }, [activeSessionId, sessionsData]);

  return {
    /** 当前激活的会话对象（无激活或未找到时为 null） */
    activeSession,
    /** 设置激活会话（传入会话 id） */
    setActiveSession,
    /** 清空激活会话（进入"新对话"未关联状态） */
    clearActiveSession,
  };
}
