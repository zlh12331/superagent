/**
 * @file 命令上下文 hook。
 *
 * 职责：为命令系统（lib/commands）提供一个稳定的 CommandContext，
 *   便于在 React 组件中调用 executeCommand 时传入上下文。
 *
 * 设计要点：
 *  - 使用模块级单例对象，确保引用稳定，避免组件每次渲染都生成新对象；
 *  - 内部通过 Zustand 的 getState() 与 notify 函数桥接到 store 与通知系统，
 *    调用时实时读取最新状态。
 */

import { useDialogStore } from '@/store/dialog-store'
import { notify } from '@/lib/notifications'
import type { CommandContext } from '@/lib/commands/types'

/**
 * 模块级单例 action，可在 React 组件之外安全调用。
 * 调用时通过 getState() 取最新状态，应视为命令式辅助函数，而非 hook。
 * 注意：使用前 store 必须已初始化（应用挂载后始终为真）。
 */
const commandContext: CommandContext = {
  openPreferences: () => useDialogStore.getState().setPreferencesOpen(true),
  showToast: (message, type = 'info') =>
    void notify(message, undefined, { type }),
}

/**
 * 命令上下文 hook —— 为命令提供必要的 action。
 *
 * 返回稳定引用（模块级单例），避免组件重渲染时引发下游命令面板的不必要刷新。
 * 调用 executeCommand 时通过本 hook 取得 context 并传入，命令实现可通过
 * context.showToast / context.openPreferences 与 UI 层交互。
 *
 * @returns CommandContext 实例（同模块单例）
 *
 * @see src/lib/commands/registry.ts — 命令注册与执行入口
 * @see src/lib/commands/types.ts — CommandContext 类型定义
 */
export function useCommandContext(): CommandContext {
  return commandContext
}
