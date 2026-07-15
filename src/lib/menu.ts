/**
 * @file 应用级原生菜单构建模块（基于 Tauri menu API）。
 *
 * 职责：
 *  - 通过 JavaScript 构建 macOS/Windows/Linux 原生菜单；
 *  - 通过 i18next 提供翻译后的菜单文案；
 *  - 将菜单项的动作路由到命令系统或对应处理函数。
 *
 * 架构位置：被 App.tsx 在启动期调用一次，并在 i18n 语言切换时重建。
 *   菜单不属于 React 树，因此通过 createMenuCommandContext 构造一个
 *   最小化的 CommandContext 桥接到 store 与通知系统。
 */

import {
  Menu,
  MenuItem,
  Submenu,
  PredefinedMenuItem,
} from '@tauri-apps/api/menu'
import i18n from '@/i18n/config'
import { useDialogStore } from '@/store/dialog-store'
import { logger } from '@/lib/logger'
import { notifications } from '@/lib/notifications'
import { executeCommand } from '@/lib/commands/registry'
import type { CommandContext } from '@/lib/commands/types'

/** 应用显示名，用于菜单首项标题与关于对话框。 */
const APP_NAME = 'SuperAgent'

/**
 * 构建并设置带翻译标签的应用菜单，返回构建好的 Menu 实例。
 *
 * 步骤：
 *  1. 通过 i18n.t 绑定获取当前语言的菜单文案；
 *  2. 分别构建应用子菜单（About/Update/Preferences/Quit）与视图子菜单（侧栏切换）；
 *  3. 通过 setAsAppMenu 设为全局应用菜单。
 *
 * 错误处理：构建失败会记录 error 日志并向上抛出，由调用方决定降级策略。
 *
 * @returns 构建完成的 Tauri Menu 实例
 */
export async function buildAppMenu(): Promise<Menu> {
  const t = i18n.t.bind(i18n)

  try {
    // 构建主应用子菜单（在 macOS 上显示为应用名）
    const appSubmenu = await Submenu.new({
      text: APP_NAME,
      items: [
        await MenuItem.new({
          id: 'about',
          text: t('menu.about', { appName: APP_NAME }),
          action: handleAbout,
        }),
        await PredefinedMenuItem.new({ item: 'Separator' }),
        await MenuItem.new({
          id: 'check-updates',
          text: t('menu.checkForUpdates'),
          action: handleCheckForUpdates,
        }),
        await PredefinedMenuItem.new({ item: 'Separator' }),
        await MenuItem.new({
          id: 'preferences',
          text: t('menu.preferences'),
          accelerator: 'CmdOrCtrl+,',
          action: handleOpenPreferences,
        }),
        await PredefinedMenuItem.new({ item: 'Separator' }),
        await PredefinedMenuItem.new({
          item: 'Hide',
          text: t('menu.hide', { appName: APP_NAME }),
        }),
        await PredefinedMenuItem.new({
          item: 'HideOthers',
          text: t('menu.hideOthers'),
        }),
        await PredefinedMenuItem.new({
          item: 'ShowAll',
          text: t('menu.showAll'),
        }),
        await PredefinedMenuItem.new({ item: 'Separator' }),
        await PredefinedMenuItem.new({
          item: 'Quit',
          text: t('menu.quit', { appName: APP_NAME }),
        }),
      ],
    })

    // 构建“视图”子菜单
    const viewSubmenu = await Submenu.new({
      text: t('menu.view'),
      items: [
        await MenuItem.new({
          id: 'toggle-left-sidebar',
          text: t('menu.toggleLeftSidebar'),
          accelerator: 'CmdOrCtrl+1',
          action: handleToggleLeftSidebar,
        }),
        await MenuItem.new({
          id: 'toggle-right-sidebar',
          text: t('menu.toggleRightSidebar'),
          accelerator: 'CmdOrCtrl+2',
          action: handleToggleRightSidebar,
        }),
      ],
    })

    // 构建完整菜单
    const menu = await Menu.new({
      items: [appSubmenu, viewSubmenu],
    })

    // 设置为应用菜单
    await menu.setAsAppMenu()

    logger.info('Application menu built successfully')
    return menu
  } catch (error) {
    logger.error('Failed to build application menu', { error })
    throw error
  }
}

/**
 * 注册 i18n 语言切换监听器，自动重建应用菜单。
 *
 * 由于菜单文案依赖 i18n.t 的运行时结果，语言切换后必须重建才能正确显示。
 * 该函数返回一个取消订阅函数，便于调用方在卸载时清理监听，
 *   避免在测试或多次挂载时产生重复回调。
 *
 * @returns 取消订阅函数，调用后即从 i18n 事件中移除该 handler
 */
export function setupMenuLanguageListener(): () => void {
  const handler = async () => {
    logger.info('Language changed, rebuilding menu')
    try {
      await buildAppMenu()
    } catch (error) {
      logger.error('Failed to rebuild menu on language change', { error })
    }
  }
  i18n.on('languageChanged', handler)
  return () => i18n.off('languageChanged', handler)
}

// === 菜单动作处理器 ===

/**
 * 为菜单动作构建 CommandContext。
 *
 * 菜单是在 React 组件树之外构建的，因此无法通过 props 接收上下文。
 * 该函数创建一个最小化的上下文，将 open-preferences 和 showToast
 * 路由到各自的 store/工具。
 */
function createMenuCommandContext(): CommandContext {
  return {
    // 直接调用 Zustand store 的 getState()，避免依赖 React 上下文
    openPreferences: () => useDialogStore.getState().setPreferencesOpen(true),
    showToast: (message: string, type?: 'success' | 'error' | 'info') => {
      switch (type) {
        case 'error':
          notifications.error(message)
          break
        case 'success':
          notifications.success(message)
          break
        default:
          notifications.info(message)
      }
    },
  }
}

/** 缓存上下文，使其每次菜单构建只创建一次，而非每次点击都创建。 */
let menuCommandContext: CommandContext | null = null

/**
 * 获取（必要时创建）菜单 CommandContext 单例。
 *
 * 缓存原因：菜单项的 action 回调在每次点击时都会执行，
 *   若每次都重新构造 context 会产生不必要的对象分配。
 */
function getMenuCommandContext(): CommandContext {
  if (!menuCommandContext) {
    menuCommandContext = createMenuCommandContext()
  }
  return menuCommandContext
}

/**
 * 处理"关于"菜单点击：弹出原生 alert 显示应用版本与构建栈信息。
 *
 * 使用 `__APP_VERSION__` 全局常量（由 Vite define 注入）。
 */
function handleAbout(): void {
  logger.info('About menu item clicked')
  alert(
    `${APP_NAME}\n\nVersion: ${__APP_VERSION__}\n\nBuilt with Tauri v2 + React + TypeScript`
  )
}

/**
 * 处理"检查更新"菜单点击：打开 UpdateDialog 弹窗。
 *
 * 对齐原型 openUpdater 函数（prototype.html L14984-15012）：
 *   不再使用 toast 通知，而是打开样式化的检查更新弹窗，
 *   弹窗内部统一处理检查流程、进度展示与错误重试。
 *
 * 实现说明：
 *  - 通过 useDialogStore.getState() 直接访问 store（菜单在 React 树外）；
 *  - UpdateDialog 组件挂载在 MainWindow 中，监听 updateOpen 自动触发检查。
 */
function handleCheckForUpdates(): void {
  logger.info('Check for Updates menu item clicked')
  useDialogStore.getState().setUpdateOpen(true)
}

/**
 * 处理"偏好设置"菜单点击：通过命令系统打开偏好设置对话框。
 *
 * 走命令系统而非直接调用 store，便于统一键盘快捷键与菜单两条入口。
 */
function handleOpenPreferences(): void {
  logger.info('Preferences menu item clicked')
  void executeCommand('open-preferences', getMenuCommandContext())
}

/**
 * 处理"切换左侧栏"菜单点击：通过命令系统切换 sidebar 可见性。
 */
function handleToggleLeftSidebar(): void {
  logger.info('Toggle Left Sidebar menu item clicked')
  void executeCommand('toggle-left-sidebar', getMenuCommandContext())
}

/**
 * 处理"切换右侧栏"菜单点击：通过命令系统切换 sidebar 可见性。
 */
function handleToggleRightSidebar(): void {
  logger.info('Toggle Right Sidebar menu item clicked')
  void executeCommand('toggle-right-sidebar', getMenuCommandContext())
}
