/**
 * @file useDeprecationNotice — 监听后端 API 弃用通知事件
 *
 * 对齐原型 §3.4 DeprecationNotice Toast（prototype.html L15081-15107）：
 *  - 后端通过 `codex:deprecation-notice` Tauri 事件推送弃用通知
 *  - 前端收到后显示紫色主题的 Toast（左边框 #9580ff + DEPRECATED 标签）
 *  - Toast 内容：method 名称 + message + 版本信息
 *  - 5 秒后自动消失（对齐原型 setTimeout 5000ms）
 *
 * 事件 payload 结构（对齐原型 L8051 deprecationNotice emit）：
 * ```ts
 * {
 *   method: string    // 弃用的 API 方法名（如 "getConversationSummary"）
 *   message: string   // 弃用提示文案
 *   version?: string  // 将在哪个版本移除（可选，如 "v1.5.0"）
 * }
 * ```
 *
 * 使用方式：在 MainWindow 中调用一次 `useDeprecationNotice()` 即可全局监听。
 *
 * @see prototype.html L15081-15107 — showDeprecationNotice 函数
 * @see prototype.html L8049-8061 — 后端 emit('deprecationNotice', ...) 调用点
 */

import { useEffect } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { toast } from 'sonner'
import { isTauri } from '@/lib/env'
import { logger } from '@/lib/logger'

/**
 * 后端 deprecationNotice 事件的 payload 结构
 *
 * 对齐原型 emit('deprecationNotice', { method, message }) 的数据格式。
 * version 字段为前端扩展（原型 showDeprecationNotice 函数的第二个参数）。
 */
export interface DeprecationNoticeEvent {
  /** 弃用的 API 方法名（如 "getConversationSummary"） */
  method: string
  /** 弃用提示文案（如 "getConversationSummary 已弃用，请使用 thread/read"） */
  message: string
  /** 将在哪个版本移除（可选，如 "v1.5.0"） */
  version?: string
}

/**
 * Tauri 事件名称 — 后端通过此名称推送弃用通知
 *
 * 命名规范：`codex:` 前缀 + kebab-case 方法名
 */
const DEPRECATION_NOTICE_EVENT = 'codex:deprecation-notice' as const

/**
 * DeprecationNotice Toast 显示时长（毫秒）
 *
 * 对齐原型 setTimeout 5000ms。
 */
const DEPRECATION_TOAST_DURATION = 5000

/**
 * 紫色主题色 — 对齐原型 .toast.deprecated 的 #9580ff
 */
const DEPRECATION_COLOR = '#9580ff'

/**
 * 显示弃用通知 Toast
 *
 * 使用 sonner 的 toast() 函数 + 自定义 title/description/style，
 * 实现原型 .toast.deprecated 的紫色主题视觉：
 *  - 左边框紫色 #9580ff（通过 style.borderLeft）
 *  - 标题后附加 "DEPRECATED" 紫色标签（通过 title 模板拼接）
 *  - 内容：message + 版本信息
 */
function showDeprecationToast(event: DeprecationNoticeEvent): void {
  // 标题：method 名称 + [DEPRECATED] 标签（对齐原型 .toast-title::after）
  const title = `${event.method}  DEPRECATED`
  // 描述：message + 版本信息
  const description = event.version
    ? `${event.message} · 将在 ${event.version} 中移除`
    : event.message

  toast.warning(title, {
    description,
    duration: DEPRECATION_TOAST_DURATION,
    // 紫色左边框 — 对齐原型 .toast.deprecated { border-left:3px solid #9580ff }
    style: {
      borderLeft: `3px solid ${DEPRECATION_COLOR}`,
    },
    // 使用紫色图标替代默认黄色
    icon: '⚠',
  })
}

/**
 * 监听后端 API 弃用通知，自动显示紫色主题 Toast。
 *
 * 仅在 Tauri 模式下注册监听器；浏览器模式（vite dev）直接跳过。
 * 采用 isMounted 守卫模式，避免 StrictMode 双挂载下的监听器泄漏。
 *
 * 副作用：
 *  - 注册 Tauri 事件监听器（codex:deprecation-notice）
 *  - 收到事件后调用 showDeprecationToast 显示 Toast
 *  - 卸载时调用 unlisten 释放资源
 *
 * 使用场景：在主窗口组件中调用一次，全局监听弃用通知。
 */
export function useDeprecationNotice(): void {
  useEffect(() => {
    // 浏览器模式无需监听 Tauri 事件
    if (!isTauri()) return

    let isMounted = true
    const unlisteners: UnlistenFn[] = []

    // 注册 Tauri 事件监听器
    listen<DeprecationNoticeEvent>(DEPRECATION_NOTICE_EVENT, e => {
      if (!isMounted) return
      const event = e.payload
      logger.warn('Deprecated API called', {
        method: event.method,
        message: event.message,
        version: event.version,
      })
      showDeprecationToast(event)
    })
      .then(fn => {
        if (!isMounted) {
          // 组件已卸载：立即释放监听器，避免泄漏
          fn()
        } else {
          unlisteners.push(fn)
        }
      })
      .catch(error => {
        logger.error(`Failed to listen ${DEPRECATION_NOTICE_EVENT}`, { error })
      })

    // 清理函数：卸载所有监听器
    return () => {
      isMounted = false
      unlisteners.forEach(fn => fn())
    }
  }, [])
}
