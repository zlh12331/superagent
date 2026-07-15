/**
 * @file 通知类命令集合。
 *
 * 职责：声明与通知系统相关的命令，主要用于开发期验证 toast 通道是否正常。
 *
 * 当前仅包含 notification.test-toast，未来可扩展如清除所有 toast、
 *   发送测试原生通知等。
 */

import type { AppCommand } from './types'
import { notifications } from '@/lib/notifications'
import i18n from '@/i18n/config'

/**
 * 通知类命令数组，供 registry 注册。
 */
export const notificationCommands: AppCommand[] = [
  {
    id: 'notification.test-toast',
    labelKey: 'commands.testToast.label',
    descriptionKey: 'commands.testToast.description',
    group: 'debug',
    keywords: ['test', 'toast', 'notification', 'debug'],
    async execute() {
      await notifications.success(
        i18n.t('toast.success.testToast'),
        i18n.t('toast.success.testToastDescription')
      )
    },
  },
]
