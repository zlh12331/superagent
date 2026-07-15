/**
 * @file 命令系统的对外聚合入口。
 *
 * 职责：
 *  - 通过 barrel 形式 re-export registry 中的注册器与执行器；
 *  - 提供唯一的 `initializeCommandSystem` 函数，按固定顺序注册所有命令模块；
 *  - re-export 各子模块的命令集合，便于外部按需引用。
 *
 * 调用时机：App.tsx 在启动期 useEffect 中调用一次。
 */

// === 命令系统核心 registry 导出 ===
export * from './registry'
import { navigationCommands } from './navigation-commands'
import { windowCommands } from './window-commands'
import { notificationCommands } from './notification-commands'
import { appCommands } from './app-commands'
import { codexCommands } from './codex-commands'
import { registerCommands } from './registry'
import { logger } from '@/lib/logger'

/**
 * 初始化命令系统，注册所有命令。
 *
 * 注册顺序约定：导航 → 窗口 → 通知 → 应用 → Codex 域命令。
 *   顺序本身无强约束，但保持稳定便于日志排查与命令 ID 冲突检测。
 *
 * 应在应用初始化期间调用一次（由 App.tsx 启动期 useEffect 触发）。
 */
export function initializeCommandSystem(): void {
  registerCommands(navigationCommands)
  registerCommands(windowCommands)
  registerCommands(notificationCommands)
  registerCommands(appCommands)
  registerCommands(codexCommands)

  // 仅在开发环境打印，避免生产环境日志噪音
  if (import.meta.env.DEV) {
    logger.debug('Command system initialized')
  }
}

/**
 * 各命令子模块的命令集合 re-export。
 *
 * 外部模块可通过此入口统一访问，例如：
 *   `import { codexCommands } from '@/lib/commands'`
 */
export {
  navigationCommands,
  windowCommands,
  notificationCommands,
  appCommands,
  codexCommands,
}
