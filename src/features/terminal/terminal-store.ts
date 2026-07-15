/**
 * Terminal feature — 终端标签页 Zustand store
 *
 * 管理多终端会话的创建、关闭、切换、更新。
 */

import { create, type StateCreator } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { TerminalId, TerminalSession } from './types'

/**
 * shell 轮换列表。
 *
 * 新建终端时若未指定 shell，按顺序轮换选择，避免多个终端都使用同一种 shell。
 * 列表与 macOS / Linux 常用 shell 顺序对齐。
 */
const SHELLS = ['zsh', 'bash', 'fish'] as const

/**
 * 默认工作目录。
 *
 * 未从后端获取实际 cwd 时使用此占位路径，UI 展示中仅作显示用途。
 */
const DEFAULT_CWD = '/home/user/project'

/**
 * 生成终端会话 ID。
 *
 * 使用「时间戳 + 6 位随机字符」组合，确保同一进程内创建的会话 ID 不冲突。
 * 格式：`term-{timestamp}-{random6}`，例如 `term-1736000000000-a1b2c3`。
 *
 * @returns 唯一会话 ID 字符串
 */
function generateTerminalId(): TerminalId {
  return `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 根据序号和 shell 创建终端会话。
 *
 * 若未传入 shell，则使用 `SHELLS[(index - 1) % SHELLS.length]` 轮换选择，
 * 兜底为 'zsh'，确保极端情况下（如 SHELLS 为空）也不会得到 undefined。
 *
 * @param index — 序号（用于标题展示，从 1 开始）
 * @param shell — 可选的 shell 类型，未指定时按 SHELLS 轮换
 * @returns 完整的 TerminalSession 对象，初始 status 为 'starting'
 *
 * @example
 * createTerminalSession(1, 'zsh')   // → { id: 'term-...', title: '1: zsh', shell: 'zsh', ... }
 * createTerminalSession(2)          // → shell 轮换为 'bash'
 */
function createTerminalSession(index: number, shell?: string): TerminalSession {
  const resolvedShell = shell ?? SHELLS[(index - 1) % SHELLS.length] ?? 'zsh'
  return {
    id: generateTerminalId(),
    title: `${index}: ${resolvedShell}`,
    shell: resolvedShell,
    cwd: DEFAULT_CWD,
    processId: null,
    status: 'starting',
    createdAt: Date.now(),
  }
}

export interface TerminalState {
  /** 当前所有终端会话列表（顺序即 Tab 显示顺序） */
  sessions: TerminalSession[]
  /** 当前激活的会话 ID（null 表示无激活会话） */
  activeId: TerminalId | null

  /**
   * 创建新终端会话。
   * @param shell — 可选 shell 类型，未指定时按 SHELLS 轮换
   * @returns 新创建会话的 ID
   */
  createSession: (shell?: string) => TerminalId
  /**
   * 关闭终端会话。
   * 至少保留 1 个 session，避免空列表；若关闭的是激活会话，自动切换到第一个。
   * @param id — 要关闭的会话 ID
   */
  closeSession: (id: TerminalId) => void
  /**
   * 设置激活会话。
   * @param id — 要激活的会话 ID
   */
  setActive: (id: TerminalId) => void
  /**
   * 局部更新会话字段（如 status / processId / cwd 等）。
   * @param id — 目标会话 ID
   * @param patch — 要覆盖的字段子集
   */
  updateSession: (
    id: TerminalId,
    patch: Partial<TerminalSession>
  ) => void
}

/**
 * 初始 3 个会话 — 对齐原型预置 Tab（1: zsh / 2: cargo / 3: git）。
 *
 * 用户首次打开终端面板即可看到 3 个预置 Tab，无需手动新建。
 */
const initialSessions: TerminalSession[] = [
  createTerminalSession(1, 'zsh'),
  createTerminalSession(2, 'cargo'),
  createTerminalSession(3, 'git'),
]

/**
 * 终端状态切片 creator。
 *
 * 使用 Zustand 的 StateCreator 模式定义状态切片，便于：
 *  - 在测试中通过 `create()(terminalStoreCreator)` 创建隔离实例
 *  - 与 devtools middleware 组合时保持类型推导
 *
 * 实现要点：
 *  - 所有写操作通过 `set()` 显式标注 action 名，便于 Redux DevTools 调试
 *  - `closeSession` 保留至少 1 个 session，避免空列表 UI
 *  - `updateSession` 使用 map + 浅合并实现局部更新
 *
 * @param set — Zustand 内部注入的 set 函数
 * @param get — Zustand 内部注入的 get 函数（用于读取当前 state）
 * @returns 完整的 TerminalState 状态切片
 */
const terminalStoreCreator: StateCreator<
  TerminalState,
  [['zustand/devtools', never]]
> = (set, get) => ({
  sessions: initialSessions,
  activeId: initialSessions[0]?.id ?? null,

  createSession: (shell?: string): TerminalId => {
    const state = get()
    // P2 修复：从现有 sessions 中提取最大序号 +1 作为新序号。
    // 此前用 sessions.length + 1，在「关闭中间会话后再新建」时会产生重复序号
    // （例如关闭 2 号后 length=2，新建得到 3，与已存在的 3 号重复）。
    // 通过正则解析标题前缀的序号取最大值，保证单调递增、永不重复。
    const maxIndex = state.sessions.reduce((max, s) => {
      const match = s.title.match(/^(\d+):/)
      // match[1] 在 noUncheckedIndexedAccess 下为 string | undefined，
      // 正则匹配成功时捕获组必为数字字符串，兜底 '0' 仅为满足类型约束
      const num = match ? parseInt(match[1] ?? '0', 10) : 0
      return Math.max(max, num)
    }, 0)
    const index = maxIndex + 1
    const session = createTerminalSession(index, shell)
    set(
      s => ({
        sessions: [...s.sessions, session],
        activeId: session.id,
      }),
      undefined,
      'createSession'
    )
    return session.id
  },

  closeSession: (id: TerminalId): void => {
    const state = get()
    // 至少保持 1 个 session
    if (state.sessions.length <= 1) return
    const sessions = state.sessions.filter(s => s.id !== id)
    const firstSession = sessions[0]
    const activeId =
      state.activeId === id ? (firstSession?.id ?? null) : state.activeId
    set({ sessions, activeId }, undefined, 'closeSession')
  },

  setActive: (id: TerminalId): void => {
    set({ activeId: id }, undefined, 'setActive')
  },

  updateSession: (id: TerminalId, patch: Partial<TerminalSession>): void => {
    set(
      s => ({
        sessions: s.sessions.map(session =>
          session.id === id ? { ...session, ...patch } : session
        ),
      }),
      undefined,
      'updateSession'
    )
  },
})

/**
 * useTerminalStore — 终端会话状态单例 hook。
 *
 * 由 `create()` 包装 `terminalStoreCreator` 并应用 devtools middleware，
 * 在 Redux DevTools 中以 `terminal-store` 名字展示。
 *
 * 使用方式：
 *  - 读取状态：`const sessions = useTerminalStore(s => s.sessions)`
 *  - 写入状态：`const createSession = useTerminalStore(s => s.createSession)`
 *
 * @example
 * function MyComponent() {
 *   const sessions = useTerminalStore(s => s.sessions)
 *   const createSession = useTerminalStore(s => s.createSession)
 *   // ...
 * }
 */
export const useTerminalStore = create<TerminalState>()(
  devtools(terminalStoreCreator, {
    name: 'terminal-store',
  })
)
