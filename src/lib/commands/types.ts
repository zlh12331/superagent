/**
 * @file 命令系统的类型定义。
 *
 * 职责：声明 AppCommand（命令描述）与 CommandContext（执行上下文）接口，
 *   供 registry、各子模块命令、命令面板等共享。
 *
 * 设计要点：
 *  - 命令的展示文案通过 i18n 翻译键传递，避免硬编码字符串；
 *  - 命令动作通过 execute(context) 接收外部依赖，便于在 React 树外执行
 *    （如菜单、键盘快捷键、命令面板三种入口共享同一份命令实现）。
 */

import type { LucideIcon } from 'lucide-react'

/**
 * 应用命令描述接口。
 *
 * 字段说明：
 *  - id             命令唯一 ID，用作 registry key 与日志/快捷键映射
 *  - labelKey       i18n 翻译键，渲染为命令标签
 *  - descriptionKey i18n 翻译键，渲染为命令描述（可选）
 *  - icon           lucide 图标组件，用于命令面板展示（可选）
 *  - group          命令分组名，用于命令面板分组展示（可选）
 *  - keywords       额外搜索关键词（可选，提升搜索召回）
 *  - execute        命令执行函数，可同步或异步
 *  - isAvailable    可用性判断函数，返回 false 时命令面板隐藏该命令（可选）
 *  - shortcut       快捷键展示文本，如 'CmdOrCtrl+,'（可选）
 */
export interface AppCommand {
  id: string
  /** 命令标签的翻译键（如 'commands.showLeftSidebar.label'） */
  labelKey: string
  /** 命令描述的翻译键（如 'commands.showLeftSidebar.description'） */
  descriptionKey?: string
  icon?: LucideIcon
  group?: string
  keywords?: string[]
  execute: (context: CommandContext) => void | Promise<void>
  isAvailable?: (context: CommandContext) => boolean
  shortcut?: string
}

/**
 * 命令执行上下文。
 *
 * 由于命令在 React 树外执行（菜单、快捷键等），无法通过 props 获取依赖，
 * 此接口定义命令可访问的最小依赖集合：
 *  - openPreferences  打开偏好设置对话框（路由到 dialog-store）
 *  - showToast        弹出 toast 通知（路由到 notifications 模块）
 *
 * 实现见 lib/menu.ts 的 createMenuCommandContext 与
 *   components/command-palette/CommandPalette.tsx 中的 context 构造。
 */
export interface CommandContext {
  // 偏好设置
  openPreferences: () => void

  // 通知
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void
}
