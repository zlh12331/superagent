/**
 * @file 窗口控制类命令集合。
 *
 * 职责：声明与窗口关闭/最小化/最大化/全屏切换相关的命令。
 *
 * 命令清单：
 *  - window-close           关闭当前窗口
 *  - window-minimize        最小化
 *  - window-toggle-maximize 切换最大化
 *  - window-fullscreen      进入全屏
 *  - window-exit-fullscreen 退出全屏
 *
 * 错误处理：所有命令在失败时通过 context.showToast 弹出 toast，
 *   不向 registry 抛出，便于命令面板静默处理。
 */

import type { AppCommand } from './types'
import { getCurrentWindow } from '@tauri-apps/api/window'
import i18n from '@/i18n/config'

/**
 * 窗口控制命令数组，供 registry 注册。
 */
export const windowCommands: AppCommand[] = [
  {
    id: 'window-close',
    labelKey: 'commands.windowClose.label',
    descriptionKey: 'commands.windowClose.description',
    shortcut: '⌘+W',

    execute: async context => {
      try {
        const appWindow = getCurrentWindow()
        await appWindow.close()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        context.showToast(
          i18n.t('toast.error.windowCloseFailed', { message }),
          'error'
        )
      }
    },
  },

  {
    id: 'window-minimize',
    labelKey: 'commands.windowMinimize.label',
    descriptionKey: 'commands.windowMinimize.description',
    shortcut: '⌘+M',

    execute: async context => {
      try {
        const appWindow = getCurrentWindow()
        await appWindow.minimize()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        context.showToast(
          i18n.t('toast.error.windowMinimizeFailed', { message }),
          'error'
        )
      }
    },
  },

  {
    id: 'window-toggle-maximize',
    labelKey: 'commands.windowToggleMaximize.label',
    descriptionKey: 'commands.windowToggleMaximize.description',

    execute: async context => {
      try {
        const appWindow = getCurrentWindow()
        await appWindow.toggleMaximize()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        context.showToast(
          i18n.t('toast.error.windowMaximizeFailed', { message }),
          'error'
        )
      }
    },
  },

  {
    id: 'window-fullscreen',
    labelKey: 'commands.windowFullscreen.label',
    descriptionKey: 'commands.windowFullscreen.description',
    shortcut: 'F11',

    execute: async context => {
      try {
        const appWindow = getCurrentWindow()
        await appWindow.setFullscreen(true)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        context.showToast(
          i18n.t('toast.error.fullscreenEnterFailed', { message }),
          'error'
        )
      }
    },
  },

  {
    id: 'window-exit-fullscreen',
    labelKey: 'commands.windowExitFullscreen.label',
    descriptionKey: 'commands.windowExitFullscreen.description',
    shortcut: 'Escape',

    execute: async context => {
      try {
        const appWindow = getCurrentWindow()
        await appWindow.setFullscreen(false)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        context.showToast(
          i18n.t('toast.error.fullscreenExitFailed', { message }),
          'error'
        )
      }
    },
  },
]
