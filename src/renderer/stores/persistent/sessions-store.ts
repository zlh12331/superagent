// src/renderer/stores/persistent/sessions-store.ts
// 激活会话状态管理（L2 客户端共享状态层 - persistent）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 仅维护当前激活会话 id（activeSessionId）作为 UI 状态
// - 持久化到 localStorage，用户重启应用后回到上次会话
//
// 设计变更（P8.3）：
// - 原设计在 Zustand 中维护整个 sessions 列表 + 持久化到 localStorage
// - 新设计：sessions 数据交给 TanStack Query 管理（通过 session:list IPC 调用 SQLite）
//   - 原因 1：避免双份持久化（SQLite 已是单一真源，localStorage 缓存会引入一致性问题）
//   - 原因 2：TanStack Query 自动处理缓存失效 + 竞态 + 重试，更符合"服务端请求状态"分层
//   - 原因 3：sessions 列表为 IPC invoke（请求-响应），按规范应走 L3 服务端请求状态层
// - 此 store 仅保留 activeSessionId（纯 UI 状态，与 sessions 列表数据解耦）
//
// 设计：
// - createSession / removeSession / updateSessionTitle / touchSession 已删除
//   （数据操作改走 IPC，TanStack Query 自动失效与刷新）
// - 仅保留 setActiveSession / clearActiveSession 两个 UI 操作
// - SessionMeta 类型 re-export 自 shared，作为单一真源
// ──────────────────────────────────────────────────────────────

import type { SessionMeta } from '@code-agent/shared/renderer';

import { createPersistentStore } from './create-persistent-store';

// 重新导出 SessionMeta（单一真源派生）
// 业务方从此处导入，避免直接依赖 shared 包的 schema 路径
export type { SessionMeta };

/**
 * 激活会话状态形状
 */
interface ActiveSessionState {
  /** 当前激活的会话 id（无激活会话时为 null） */
  readonly activeSessionId: string | null;

  // ── 操作方法 ────────────────────────────────────────
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

// ── 兼容别名（便于渐进式重构，业务方可逐步迁移） ────────────────
// 旧代码引用 useSessionsStore 的位置可暂改为 useActiveSessionStore
// 待 P8.4-P8.6 重构完成后，此别名可删除
export const useSessionsStore = useActiveSessionStore;
