/**
 * useAccountListener — 监听账户状态变化（Task 19）
 *
 * 在组件挂载时：
 * 1. 初次加载账户信息（getAccount）
 * 2. 注册 account/login/completed 监听器（登录完成后刷新账户）
 * 3. 注册 account/updated 监听器（账户状态变化时同步 UI）
 *
 * 采用 cancelled 守卫模式：若监听器注册完成前组件已卸载，
 * 立即调用 unlisten 释放资源，避免 StrictMode 双挂载下的监听器泄漏。
 *
 * @see src/lib/codex/account.ts — 事件监听 API
 * @see src/features/account/account-store.ts — 状态管理
 */

import { useEffect } from 'react'
import { toast } from 'sonner'
import {
  onLoginCompleted,
  onAccountUpdated,
  getAccount,
} from '@/lib/codex/account'
import { useAccountStore } from './account-store'
import { logger } from '@/lib/logger'

/** 监听账户事件，自动更新 account store */
export function useAccountListener(): void {
  const setAccount = useAccountStore(s => s.setAccount)
  const setAuthStatus = useAccountStore(s => s.setAuthStatus)

  useEffect(() => {
    let unlistenCompleted: (() => void) | null = null
    let unlistenUpdated: (() => void) | null = null
    let cancelled = false

    // 1. 初次加载账户信息
    getAccount()
      .then(account => {
        if (!cancelled && account) {
          setAccount(account)
          setAuthStatus({
            authenticated: true,
            provider: account.authMode,
            accountLabel: account.email,
          })
        }
      })
      .catch(err => {
        // Bug 11: 初次加载失败时记录日志、置为未登录状态并提示用户，
        // 避免静默失败导致 UI 长时间停留在“加载中”或无反馈状态。
        if (!cancelled) {
          logger.error('Failed to load account', { error: err })
          setAuthStatus({
            authenticated: false,
            provider: null,
            accountLabel: null,
          })
          toast.error('账户信息加载失败，请检查网络后重试')
        }
      })

    // 2. 监听登录完成事件
    onLoginCompleted(event => {
      setAuthStatus({
        authenticated: true,
        provider: event.provider,
        accountLabel: event.account,
      })
      // 重新获取账户信息以同步 plan 等字段
      getAccount()
        .then(account => {
          // Bug 10: 添加 cancelled 守卫，组件卸载后不再更新 store，避免内存泄漏与脏写
          if (cancelled) return
          if (account) setAccount(account)
        })
        .catch(err => {
          // 登录完成但获取详情失败时不阻塞 UI，仅记录日志便于排查
          logger.error('Failed to get account after login completed', { error: err })
        })
    })
      .then(un => {
        // 注册完成前组件已卸载：立即释放
        if (cancelled) {
          un()
          return
        }
        unlistenCompleted = un
      })
      .catch(err => {
        // 监听器注册失败时记录日志（浏览器模式不会走到这里）
        logger.error('Failed to subscribe login completed event', { error: err })
      })

    // 3. 监听账户状态变化
    onAccountUpdated(status => {
      setAuthStatus(status)
    })
      .then(un => {
        if (cancelled) {
          un()
          return
        }
        unlistenUpdated = un
      })
      .catch(err => {
        // 监听器注册失败时记录日志
        logger.error('Failed to subscribe account updated event', { error: err })
      })

    return () => {
      cancelled = true
      unlistenCompleted?.()
      unlistenUpdated?.()
    }
  }, [setAccount, setAuthStatus])
}
