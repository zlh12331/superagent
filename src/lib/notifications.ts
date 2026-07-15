/**
 * @file 通知系统模块。
 *
 * 职责：统一封装应用内 toast（基于 sonner）与原生系统通知（基于 Tauri 命令），
 *   并提供按类型分类的便捷函数。
 *
 * 设计意图：
 *  - 调用方仅需关心 type 与文案，无需感知后端差异；
 *  - 原生通知失败时自动回退到 toast，保证用户一定能看到反馈；
 *  - 通过 `notifications.success/error/...` 与解构导出 `success/error/...`
 *    两种形式适配不同调用风格。
 */

import { toast } from 'sonner'
import { logger } from './logger'
import { commands } from './tauri-bindings'

/** 通知类型字面量联合，对应 sonner 的四种内置 toast 样式。 */
type NotificationType = 'success' | 'error' | 'info' | 'warning'

/**
 * 通知选项。
 *
 * - type     通知类型，决定 toast 图标与配色
 * - native   true 时走 Tauri 原生通知；false/省略走应用内 toast
 * - duration toast 自动消失时长（毫秒），0 表示常驻；仅对 toast 生效
 */
interface NotificationOptions {
  /** 通知类型（影响样式） */
  type?: NotificationType
  /** 是否作为原生系统通知发送，而非 toast */
  native?: boolean | undefined
  /** toast 显示时长（毫秒，0 表示不自动消失） */
  duration?: number
}

/**
 * 发送通知 —— 可选择应用内 toast 或原生系统通知。
 *
 * 路由策略：
 *  - `native: true`  走 Tauri 原生通知（操作系统通知中心）；
 *  - `native: false`（默认）走 sonner toast（应用内浮层）。
 *
 * 失败回退：原生通知发送失败时会自动降级为 toast.error，
 *   保证用户一定能收到反馈（避免静默失败）。
 *
 * @param title   通知主标题
 * @param message 可选的消息正文；省略时 toast 仅显示标题
 * @param options 通知选项，控制类型、是否走原生、停留时长
 *
 * @example
 * ```typescript
 * // 简单 toast
 * notify('Success!', 'File saved successfully')
 *
 * // 错误 toast
 * notify('Error', 'Failed to save file', { type: 'error' })
 *
 * // 原生系统通知（出现在 OS 通知中心）
 * notify('Update Available', 'A new version is ready to install', { native: true })
 * ```
 */
export async function notify(
  title: string,
  message?: string,
  options: NotificationOptions = {}
): Promise<void> {
  const { type = 'info', native = false, duration } = options

  try {
    if (native) {
      // 通过 Tauri 发送原生系统通知（OS 通知中心）
      logger.debug('Sending native notification', { title, message, type })
      const result = await commands.sendNativeNotification(
        title,
        message ?? null
      )
      if (result.status === 'error') {
        throw new Error(result.error.message)
      }
    } else {
      // 发送应用内 toast 通知（sonner 浮层）
      logger.debug('Sending toast notification', { title, message, type })

      const toastContent = message ? `${title}: ${message}` : title
      const toastOptions = duration !== undefined ? { duration } : {}

      switch (type) {
        case 'success':
          toast.success(toastContent, toastOptions)
          break
        case 'error':
          toast.error(toastContent, toastOptions)
          break
        case 'warning':
          toast.warning(toastContent, toastOptions)
          break
        case 'info':
        default:
          toast.info(toastContent, toastOptions)
          break
      }
    }
  } catch (error) {
    logger.error('Failed to send notification', { title, message, error })
    // 原生通知失败时回退到 toast，确保用户一定能看到反馈
    if (native) {
      toast.error(`${title}${message ? `: ${message}` : ''}`)
    }
  }
}

/**
 * 常用通知类型的便捷函数
 */
export const notifications = {
  /** 显示 success 通知 */
  success: (title: string, message?: string, native?: boolean) =>
    notify(title, message, { type: 'success', native }),

  /** 显示 error 通知 */
  error: (title: string, message?: string, native?: boolean) =>
    notify(title, message, { type: 'error', native }),

  /** 显示 info 通知 */
  info: (title: string, message?: string, native?: boolean) =>
    notify(title, message, { type: 'info', native }),

  /** 显示 warning 通知 */
  warning: (title: string, message?: string, native?: boolean) =>
    notify(title, message, { type: 'warning', native }),
}

/**
 * 便捷的独立通知函数（解构自 notifications 命名空间）。
 *
 * 适用场景：在非组件模块中希望一行调用即可弹出通知，
 *   例如 `import { success } from '@/lib/notifications'`。
 */
export const { success, error, info, warning } = notifications
