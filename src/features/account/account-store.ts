/**
 * Account Store — 账户状态管理（Task 19）
 *
 * 维护当前账户信息（AccountInfo）与认证状态（AuthStatus）。
 * 该 store 不持久化：账户敏感信息由 keyring / OAuth token 管理，
 * 这里仅缓存 UI 展示所需的内存状态。
 *
 * 数据流:
 *   useAccountListener 监听 Tauri 事件 → 更新 store → UI 响应渲染
 *
 * @see src/features/account/useAccountListener.ts — 事件监听 hook
 * @see src/lib/codex/account.ts — AccountInfo / AuthStatus 类型与 API
 */

import { create, type StateCreator } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { AccountInfo } from '@/lib/codex/types'
import type { AuthStatus } from '@/lib/codex/account'

export interface AccountState {
  /** 当前账户信息（未登录时为 null） */
  account: AccountInfo | null
  /** 认证状态（用于 UI 标识是否已登录、登录方式） */
  authStatus: AuthStatus
  /** 设置账户信息 */
  setAccount: (account: AccountInfo | null) => void
  /** 更新认证状态 */
  setAuthStatus: (status: AuthStatus) => void
  /** 清空账户（登出后调用） */
  clearAccount: () => void
}

/** 未登录时的默认认证状态 */
const DEFAULT_AUTH_STATUS: AuthStatus = {
  authenticated: false,
  provider: null,
  accountLabel: null,
}

/**
 * Account Store creator —— Zustand 状态切片工厂。
 *
 * 不直接调用 `create()`，便于在测试中将此 creator 传入独立的 store 实例，
 * 避免污染全局单例。模式与 src/store/* 中的其他 store 一致。
 *
 * @param set —— Zustand 的 set 函数，第二参数 `undefined` 表示不替换 state 引用名，
 *   第三参数为 Redux DevTools 中显示的 action 名称。
 */
const accountStoreCreator: StateCreator<
  AccountState,
  [['zustand/devtools', never]]
> = set => ({
  account: null,
  authStatus: DEFAULT_AUTH_STATUS,

  setAccount: account => set({ account }, undefined, 'setAccount'),

  setAuthStatus: authStatus => set({ authStatus }, undefined, 'setAuthStatus'),

  clearAccount: () =>
    set(
      { account: null, authStatus: DEFAULT_AUTH_STATUS },
      undefined,
      'clearAccount'
    ),
})

/**
 * Account Store 单例 hook。
 *
 * 通过 Zustand `create()` 创建全局唯一实例，并启用 devtools middleware
 * 便于在 Redux DevTools 中观察 state 变更（name='account-store'）。
 *
 * @example
 * const account = useAccountStore(s => s.account)
 * const setAccount = useAccountStore(s => s.setAccount)
 */
export const useAccountStore = create<AccountState>()(
  devtools(accountStoreCreator, { name: 'account-store' })
)
