// src/renderer/stores/sessions-store.ts
// 会话状态管理（zustand）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 维护会话列表（sessions）与当前激活会话 id（activeSessionId）
// - 提供创建 / 切换 / 删除会话的原子操作
// - 仅为状态容器，不包含 IPC 调用逻辑（业务 hook 负责副作用）
//
// 设计：
// - 使用 zustand 5 的 createStore API，配合 persist 中间件持久化到 localStorage
// - 不依赖 useChat：useChat 维护单次对话的 messages，本 store 维护多会话元数据
// - 跨组件共享：通过 useSessionsStore() 订阅，避免 props drilling
//
// 注意：
// - 当前不存储 messages（messages 由 useChat 维护，未来若持久化到 SQLite 再迁移）
// - 仅持久化 sessions + activeSessionId，messages 走主进程持久化通道
// ──────────────────────────────────────────────────────────────

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * 单个会话的元数据
 *
 * 不含 messages（消息体由 useChat 维护，避免重复存储）。
 * 后续接入 SQLite 持久化后，可扩展为完整持久化模型。
 */
export interface SessionMeta {
  /** 会话唯一标识（与 useChat 的 chatId 对齐） */
  readonly id: string;
  /** 会话标题（由首条用户消息截取生成） */
  readonly title: string;
  /** 创建时间戳（ms） */
  readonly createdAt: number;
  /** 最近一次更新时间戳（ms） */
  readonly updatedAt: number;
}

/**
 * 会话状态形状
 */
interface SessionsState {
  /** 会话列表（按 updatedAt 倒序，最近活动的在最前） */
  readonly sessions: SessionMeta[];
  /** 当前激活的会话 id（无激活会话时为 null） */
  readonly activeSessionId: string | null;

  // ── 操作方法 ────────────────────────────────────────
  /** 创建新会话并设为激活 */
  readonly createSession: (id: string, title: string) => void;
  /** 切换激活会话 */
  readonly setActiveSession: (id: string) => void;
  /** 删除指定会话（若为激活会话，则清空 activeSessionId） */
  readonly removeSession: (id: string) => void;
  /** 更新会话标题 */
  readonly updateSessionTitle: (id: string, title: string) => void;
  /** 触摸会话（更新 updatedAt，用于排序） */
  readonly touchSession: (id: string) => void;
}

/**
 * 会话状态 store
 *
 * 持久化到 localStorage（key: 'novel-writer-sessions'）。
 *
 * @example
 * ```tsx
 * const sessions = useSessionsStore((s) => s.sessions);
 * const createSession = useSessionsStore((s) => s.createSession);
 * ```
 */
export const useSessionsStore = create<SessionsState>()(
  persist(
    (set) => ({
      sessions: [],
      activeSessionId: null,

      createSession: (id, title) =>
        set((state) => {
          const now = Date.now();
          const session: SessionMeta = {
            id,
            title,
            createdAt: now,
            updatedAt: now,
          };
          // 新会话置于列表最前（最近活动）
          return {
            sessions: [session, ...state.sessions],
            activeSessionId: id,
          };
        }),

      setActiveSession: (id) =>
        set(() => ({
          activeSessionId: id,
        })),

      removeSession: (id) =>
        set((state) => {
          const sessions = state.sessions.filter((s) => s.id !== id);
          const activeSessionId = state.activeSessionId === id ? null : state.activeSessionId;
          return { sessions, activeSessionId };
        }),

      updateSessionTitle: (id, title) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === id ? { ...s, title, updatedAt: Date.now() } : s,
          ),
        })),

      touchSession: (id) =>
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === id ? { ...s, updatedAt: Date.now() } : s)),
        })),
    }),
    {
      name: 'novel-writer-sessions',
      // 仅持久化状态数据，不持久化方法
      partialize: (state) => ({
        sessions: state.sessions,
        activeSessionId: state.activeSessionId,
      }),
    },
  ),
);
