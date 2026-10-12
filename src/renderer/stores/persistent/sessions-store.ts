import type { SessionMeta } from '@code-agent/shared/renderer';

import { createPersistentStore } from './create-persistent-store';

export type { SessionMeta };

/**
 * 激活会话状态形状
 */
interface ActiveSessionState {
  /** 当前激活的会话 id（无激活会话时为 null） */
  readonly activeSessionId: string | null;

  /** 设置激活会话（用户点击会话列表项时调用） */
  readonly setActiveSession: (id: string) => void;
  /** 清空激活会话（用户点击"新对话"按钮时调用，表示进入未关联会话的临时状态） */
  readonly clearActiveSession: () => void;
}

/**
 * 激活会话状态 store
 *
 * 持久化到 localStorage（key: 'code-agent:active-session'）。
 *
 * 与原 sessions-store 的差异：
 * - 仅持久化 activeSessionId（一个字符串或 null），不持久化 sessions 列表
 * - sessions 列表由 TanStack Query 通过 session:list IPC 拉取 SQLite 数据
 * - 用户切换会话后，业务 hook 根据 activeSessionId 加载对应 session:get 数据
 *
 * @example
 * ```tsx
 * const activeSessionId = useActiveSessionStore((s) => s.activeSessionId);
 * const setActiveSession = useActiveSessionStore((s) => s.setActiveSession);
 * ```
 */
export const useActiveSessionStore = createPersistentStore<ActiveSessionState>()(
  (set) => ({
    activeSessionId: null,

    setActiveSession: (id) =>
      set(() => ({
        activeSessionId: id,
      })),

    clearActiveSession: () =>
      set(() => ({
        activeSessionId: null,
      })),
  }),
  {
    name: 'active-session',
    version: 1,
    partialize: (state) => ({
      activeSessionId: state.activeSessionId,
    }),
  },
);
