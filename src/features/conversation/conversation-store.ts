/**
 * Conversation Store — 对话区纯 UI 状态（Zustand）
 *
 * 状态管理决策树位置：
 *   useState → Zustand → TanStack Query
 *   消息列表（服务端持久化数据）已迁移到 TanStack Query（src/queries/messages.ts），
 *   本 store 仅保留纯 UI 状态：发送中标志、活跃轮次、轮次历史。
 *
 * 迁移说明：
 *   - messagesByThread / loadingByThread 已移除，由 useMessages hook 替代
 *   - loadMessages / sendMessage / cancelActiveTurn 已移除，
 *     由 useMessages / useStartTurn / useCancelTurn 钩子替代
 *   - getMessages / setMessages / appendMessage / setLoading / clearThread 已移除
 *   - 保留 sendingByThread（mutation pending 状态需跨组件共享，ChatInput 禁用输入框）
 *   - 保留 activeTurnByThread（活跃轮次状态，用于显示中断按钮、进度条等）
 *   - 保留 turnsByThread（轮次历史，用于垂直进度条导航）
 *
 * 事件驱动更新：
 *   ConversationArea 监听 codex:notification 事件后调用 invalidateMessages，
 *   TanStack Query 自动重新拉取最新消息，无需手工 appendMessage。
 */

import { create, type StateCreator } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { Turn, ThreadId, TurnStatus } from '@/lib/codex/types'

/** 按 threadId 索引的活跃轮次（当前正在进行的 turn） */
type ActiveTurnByThread = Record<string, Turn | null>

/** 按 threadId 索引的轮次历史（用于进度条） */
type TurnsByThread = Record<string, Turn[]>

/** 按 threadId 索引的发送状态（禁用输入框） */
type SendingByThread = Record<string, boolean>

/**
 * 单个文件的 diff 变更（patch 审批追踪）。
 *
 * 注意：此接口仍被 context-panel/DiffPane.tsx 引用，不是死代码。
 * lines 中的 type 使用 'ctx' | 'add' | 'del'（对齐原型命名），
 * DiffPane 内部会映射为 'context' | 'add' | 'del'。
 */
export interface TurnDiff {
  /** 文件路径（相对路径） */
  path: string
  /** 新增行数 */
  additions: number
  /** 删除行数 */
  deletions: number
  /** diff 行列表 */
  lines: { type: 'ctx' | 'add' | 'del'; text: string }[]
}

/** 按 threadId 索引的引用文件路径列表（patch 审批追踪，InfoPane 使用） */
type ReferencedFilesByThread = Record<string, string[]>

/** 按 threadId 索引的文件变更 diff 列表（patch 审批追踪，DiffPane 使用） */
type TurnDiffsByThread = Record<string, TurnDiff[]>

/**
 * 从 Record 中删除指定 key，返回新对象（不可变更新）。
 * 用于 clearThread 操作，避免使用解构产生未使用变量。
 */
function filterKey<T>(
  record: Record<string, T>,
  key: string
): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))
}

export interface ConversationStoreState {
  /** threadId → 当前活跃轮次（null 表示无进行中的轮次） */
  activeTurnByThread: ActiveTurnByThread
  /** threadId → 轮次历史列表（用于进度条导航） */
  turnsByThread: TurnsByThread
  /** threadId → 是否正在发送消息（禁用输入框） */
  sendingByThread: SendingByThread
  /**
   * threadId → 引用文件路径列表（patch 审批追踪）。
   * 由 context-panel/InfoPane.tsx 读取，展示本轮会话引用的文件。
   */
  referencedFilesByThread: ReferencedFilesByThread
  /**
   * threadId → 文件变更 diff 列表（patch 审批追踪）。
   * 由 context-panel/DiffPane.tsx 读取，展示本轮会话的文件变更。
   */
  turnDiffsByThread: TurnDiffsByThread

  // ---- 查询方法 ----
  /** 获取指定 thread 的活跃轮次 */
  getActiveTurn: (threadId: ThreadId) => Turn | null
  /** 获取指定 thread 的轮次历史 */
  getTurns: (threadId: ThreadId) => Turn[]
  /** 获取指定 thread 的轮次状态（用于进度条 tooltip） */
  getTurnStatus: (threadId: ThreadId) => TurnStatus
  /** 获取指定 thread 的发送状态 */
  isSending: (threadId: ThreadId) => boolean

  // ---- 同步操作 ----
  /** 设置指定 thread 的活跃轮次（仅更新 activeTurnByThread，不触碰历史） */
  setActiveTurn: (threadId: ThreadId, turn: Turn | null) => void
  /**
   * 追加终态轮次到历史列表（用于进度条导航）。
   * 去重逻辑：若 turn.id 已存在则原地更新，否则追加到末尾。
   * 与 setActiveTurn 解耦，避免同一 turn.id 被重复追加导致 React key 冲突。
   */
  appendTurnHistory: (threadId: ThreadId, turn: Turn) => void
  /** 设置指定 thread 的发送状态 */
  setSending: (threadId: ThreadId, sending: boolean) => void
  /** 清除指定 thread 的所有对话 UI 状态 */
  clearThread: (threadId: ThreadId) => void
}

/**
 * Conversation Store creator —— Zustand 状态切片工厂。
 *
 * 不直接调用 `create()`，便于在测试中将此 creator 传入独立的 store 实例，
 * 避免污染全局单例。模式与 src/store/* 中的其他 store 一致。
 *
 * 实现要点：
 *  - 所有写入操作均不可变（spread 复制 Record）；
 *  - `setActiveTurn` 与 `appendTurnHistory` 解耦，避免同一 turn.id 被重复追加；
 *  - `clearThread` 使用 `filterKey` 工具函数实现不可变删除。
 *
 * @param set —— Zustand 的 set 函数（带 devtools action 名）
 * @param get —— Zustand 的 get 函数（用于读取当前 state）
 */
const conversationStoreCreator: StateCreator<
  ConversationStoreState,
  [['zustand/devtools', never]]
> = (set, get) => ({
  activeTurnByThread: {},
  turnsByThread: {},
  sendingByThread: {},
  // patch 审批追踪状态（由 context-panel 读取，暂无写入入口，初始化为空）
  referencedFilesByThread: {},
  turnDiffsByThread: {},

  // ---- 查询方法 ----
  getActiveTurn: threadId => get().activeTurnByThread[threadId] ?? null,

  getTurns: threadId => get().turnsByThread[threadId] ?? [],

  getTurnStatus: threadId => {
    const turn = get().activeTurnByThread[threadId]
    return turn ? turn.status : 'completed'
  },

  isSending: threadId => get().sendingByThread[threadId] ?? false,

  // ---- 同步操作 ----
  // setActiveTurn 仅负责设置活跃轮次（单一职责）。
  // 不再在此处追加到 turnsByThread —— 历史追加由 appendTurnHistory 专门负责，
  // 这样 startTurn（启动轮次）和 cancelTurn（结束轮次）可以分别决定
  // 何时写入历史，避免同一 turn.id 被重复追加。
  setActiveTurn: (threadId, turn) =>
    set(
      state => ({
        activeTurnByThread: { ...state.activeTurnByThread, [threadId]: turn },
      }),
      undefined,
      'setActiveTurn'
    ),

  // appendTurnHistory 专门负责将终态 turn 写入 turnsByThread 历史。
  // 去重策略：按 turn.id 检查 —— 已存在则原地替换（保留原位置），
  // 不存在则追加到末尾。这样可保证 VerticalProgressBar 中 turn.id 作为
  // React key 的唯一性。
  appendTurnHistory: (threadId, turn) =>
    set(
      state => {
        // noUncheckedIndexedAccess 下需用 ?? 兜底
        const existing = state.turnsByThread[threadId] ?? []
        const index = existing.findIndex(t => t.id === turn.id)
        // 同 id 则原地替换，否则追加
        const nextTurns =
          index >= 0
            ? existing.map((t, i) => (i === index ? turn : t))
            : [...existing, turn]
        return {
          turnsByThread: {
            ...state.turnsByThread,
            [threadId]: nextTurns,
          },
        }
      },
      undefined,
      'appendTurnHistory'
    ),

  setSending: (threadId, sending) =>
    set(
      state => ({
        sendingByThread: { ...state.sendingByThread, [threadId]: sending },
      }),
      undefined,
      'setSending'
    ),

  // clearThread：清理指定 thread 的全部对话 UI 状态
  // 包含 patch 审批追踪状态（referencedFilesByThread / turnDiffsByThread）
  clearThread: threadId =>
    set(
      state => ({
        activeTurnByThread: filterKey(state.activeTurnByThread, threadId),
        turnsByThread: filterKey(state.turnsByThread, threadId),
        sendingByThread: filterKey(state.sendingByThread, threadId),
        referencedFilesByThread: filterKey(
          state.referencedFilesByThread,
          threadId
        ),
        turnDiffsByThread: filterKey(state.turnDiffsByThread, threadId),
      }),
      undefined,
      'clearThread'
    ),
})

/**
 * Conversation Store 单例 hook。
 *
 * 通过 Zustand `create()` 创建全局唯一实例，并启用 devtools middleware
 * 便于在 Redux DevTools 中观察 state 变更（name='conversation-store'）。
 *
 * @example
 * const activeTurn = useConversationStore(s => s.getActiveTurn(threadId))
 * const setSending = useConversationStore(s => s.setSending)
 */
export const useConversationStore = create<ConversationStoreState>()(
  devtools(conversationStoreCreator, {
    name: 'conversation-store',
  })
)
