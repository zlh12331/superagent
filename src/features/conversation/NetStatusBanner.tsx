/**
 * NetStatusBanner — codex 运行时连接状态横幅
 *
 * 对应 prototype.html 的 `.net-status-banner`（第 925-942 行）。
 *
 * 功能职责：
 *   1. 监听 `codex:disconnected` 事件 — 运行时断连时显示红色横幅
 *   2. 监听 `codex:lagged` 事件 — 事件背压时显示蓝色"同步中"横幅
 *   3. 收到后续 `codex:notification` 后自动从 lagged 状态恢复
 *
 * 事件来源：src-tauri/codex-rs/desktop/src/bridge/event.rs
 *   - `codex:disconnected` — payload 是断开原因（string）
 *   - `codex:lagged` — payload 是丢弃的事件数量（number）
 *   - `codex:notification` — 任何通知表示连接正常
 *
 * 状态机：
 *   connected（默认，隐藏）
 *     ↓ codex:lagged
 *   reconnecting（蓝色，"正在同步事件…"）
 *     ↓ codex:notification 或 5s 超时
 *   connected
 *
 *   connected / reconnecting
 *     ↓ codex:disconnected
 *   disconnected（红色，终态，需重启应用）
 *
 * 参考样式：prototype.html 第 925-942 行
 *   - 断开（红色）：背景半透明 error、下边框 error、文字 error
 *   - 同步中（蓝色）：背景 info-blue、下边框 accent、文字 accent
 */

import { useEffect, useRef, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { toast } from 'sonner'
import { RefreshCw, WifiOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isTauri } from '@/lib/env'
import { logger } from '@/lib/logger'

/** 网络状态类型 */
type NetStatus = 'connected' | 'disconnected' | 'reconnecting'

/**
 * lagged 状态自动恢复超时（毫秒）。
 *
 * 收到 codex:lagged 后显示"同步中"，如果在此时长内没有收到
 * codex:notification（TurnCompleted 通常会触发 backfill 恢复），
 * 则强制恢复为 connected，避免横幅永久卡在 reconnecting。
 */
const LAGGED_RECOVERY_TIMEOUT_MS = 5000

/**
 * NetStatusBanner 组件 —— codex 运行时连接状态横幅。
 *
 * 渲染逻辑：
 *  - `connected`（默认）：返回 null，不渲染横幅
 *  - `reconnecting`：渲染蓝色"正在同步事件…"横幅 + 旋转 RefreshCw 图标
 *  - `disconnected`：渲染红色"运行时已断开"横幅 + WifiOff 图标（终态，需重启）
 *
 * 副作用：
 *  - 监听 `codex:disconnected` / `codex:lagged` / `codex:notification` 三个 Tauri 事件
 *  - lagged 状态下设置 5s 超时计时器作为兜底恢复
 *  - 浏览器模式（非 Tauri）直接跳过事件监听
 *
 * 状态机：见文件头注释
 */
export function NetStatusBanner() {
  // 当前连接状态（默认已连接，横幅不显示）
  const [status, setStatus] = useState<NetStatus>('connected')
  // 断连原因（仅 disconnected 状态有值，用于显示具体错误信息）
  const [disconnectReason, setDisconnectReason] = useState<string>('')

  // lagged 恢复计时器引用 — 用于在收到新 lagged 时清除旧计时器
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // 浏览器模式（vite dev）无需监听 Tauri 事件
    if (!isTauri()) return

    let isMounted = true
    const unlisteners: UnlistenFn[] = []

    // ---- 监听 codex:disconnected（终态：运行时崩溃或正常关闭）----
    // payload 是断开原因字符串（如 "event stream closed by runtime"）
    listen<string>('codex:disconnected', e => {
      if (!isMounted) return
      setStatus('disconnected')
      setDisconnectReason(e.payload || 'event stream closed')
      // 断连是终态，清除可能的 lagged 恢复计时器
      if (recoveryTimerRef.current) {
        clearTimeout(recoveryTimerRef.current)
        recoveryTimerRef.current = null
      }
      logger.warn('Codex runtime disconnected', { reason: e.payload })
    })
      .then(fn => {
        if (!isMounted) {
          fn()
        } else {
          unlisteners.push(fn)
        }
      })
      .catch(error => {
        logger.error('Failed to listen codex:disconnected', { error })
      })

    // ---- 监听 codex:lagged（暂时状态：事件循环背压）----
    // payload 是被丢弃的事件数量（usize）
    listen<number>('codex:lagged', e => {
      if (!isMounted) return
      // 仅在 connected 状态下切换到 reconnecting
      // （disconnected 是终态，不应被 lagged 覆盖）
      setStatus(prev => (prev === 'disconnected' ? prev : 'reconnecting'))
      // 清除之前的恢复计时器（可能存在未触发的旧计时器）
      if (recoveryTimerRef.current) {
        clearTimeout(recoveryTimerRef.current)
      }
      // 设定 fallback 恢复：若超时内未收到 notification，强制恢复
      recoveryTimerRef.current = setTimeout(() => {
        if (isMounted) {
          setStatus(prev => {
            if (prev === 'reconnecting') {
              // 超时强制恢复：提示用户网络已恢复
              toast.success('网络已恢复')
              return 'connected'
            }
            return prev
          })
        }
        recoveryTimerRef.current = null
      }, LAGGED_RECOVERY_TIMEOUT_MS)
      logger.warn('Event loop lagged', { dropped: e.payload })
    })
      .then(fn => {
        if (!isMounted) {
          fn()
        } else {
          unlisteners.push(fn)
        }
      })
      .catch(error => {
        logger.error('Failed to listen codex:lagged', { error })
      })

    // ---- 监听 codex:notification（恢复信号：连接正常）----
    // 收到任何通知表示事件流恢复正常，从 reconnecting 恢复到 connected
    // 注意：Tauri listen 是多播的，此处监听不会影响 ConversationArea 的监听
    listen<unknown>('codex:notification', () => {
      if (!isMounted) return
      setStatus(prev => {
        if (prev === 'reconnecting') {
          // 收到通知，清除恢复计时器并恢复
          if (recoveryTimerRef.current) {
            clearTimeout(recoveryTimerRef.current)
            recoveryTimerRef.current = null
          }
          // 事件流恢复正常：提示用户网络已恢复
          toast.success('网络已恢复')
          return 'connected'
        }
        return prev
      })
    })
      .then(fn => {
        if (!isMounted) {
          fn()
        } else {
          unlisteners.push(fn)
        }
      })
      .catch(error => {
        logger.error('Failed to listen codex:notification for recovery', {
          error,
        })
      })

    return () => {
      isMounted = false
      unlisteners.forEach(fn => fn())
      if (recoveryTimerRef.current) {
        clearTimeout(recoveryTimerRef.current)
        recoveryTimerRef.current = null
      }
    }
  }, [])

  // 已连接时不渲染横幅（原型 .net-status-banner 默认 display:none，.show 时显示）
  if (status === 'connected') return null

  // 是否处于同步中（决定使用蓝色 reconnecting 样式）
  const isReconnecting = status === 'reconnecting'
  // 横幅文案
  const text = isReconnecting
    ? '正在同步事件…'
    : disconnectReason
      ? `codex 运行时已断开：${disconnectReason}，请重启应用`
      : 'codex 运行时已断开，请重启应用'

  return (
    <div
      // P0 修复：role="status" → role="alert"（断连为关键错误，需即时通知屏幕阅读器）
      //   aria-live="polite" → "assertive"（断连需高优先级打断播报）
      role="alert"
      aria-live="assertive"
      className={cn(
        // 参考原型 .net-status-banner：居中布局、8px 14px padding、12px 字号、8px 间距
        'flex items-center justify-center gap-2 px-3.5 py-2 text-xs',
        isReconnecting
          ? // 同步中（.reconnecting）：蓝色背景 + accent 下边框 + accent 文字
            'border-b border-[var(--accent)] bg-[var(--info-blue)] text-[var(--accent)]'
          : // P0 修复：背景色改用 var(--error-bg,rgba(255,99,71,0.12))（对齐原型 background:var(--error-bg,rgba(255,99,71,0.12))）
            'border-b border-[var(--error)] bg-[var(--error-bg,rgba(255,99,71,0.12))] text-[var(--error)]'
      )}
    >
      {isReconnecting ? (
        // 同步中：旋转的刷新图标，表示正在尝试恢复
        <RefreshCw className="size-3.5 animate-spin" />
      ) : (
        // 断开：Wifi 断开图标
        <WifiOff className="size-3.5" />
      )}
      <span>{text}</span>
    </div>
  )
}
