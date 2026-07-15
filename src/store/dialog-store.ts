/**
 * @file 应用级对话框开关状态的 Zustand store。
 *
 * 职责：集中管理命令面板、偏好设置、登录、账户、快捷键帮助等
 *   全局对话框的开关状态，避免组件间通过 props 传递。
 *
 * 设计要点：
 *  - 不持久化（重启后所有对话框关闭，避免遗留状态）；
 *  - 每个 dialog 提供 set 与 toggle 两种方法，toggle 便于键盘快捷键直接调用；
 *  - 通过 devtools 中间件可在 Redux DevTools 中观察变更历史。
 */

import { create, type StateCreator } from 'zustand'
import { devtools } from 'zustand/middleware'

/**
 * Dialog store 状态接口。
 *
 * 每个 boolean 字段对应一个对话框，true 表示打开。
 * 对应的 set* 方法直接设置，toggle* 方法基于当前值反转。
 * toggle* 方法主要服务于键盘快捷键（一次按键切换），
 * set* 方法主要服务于命令面板、菜单等显式打开/关闭操作。
 */
export interface DialogState {
  /** 命令面板（Cmd/Ctrl+K）是否打开 */
  commandPaletteOpen: boolean
  /** 偏好设置对话框是否打开 */
  preferencesOpen: boolean
  /** 登录弹窗是否打开（Task 19） */
  loginOpen: boolean
  /** 账户信息弹窗是否打开（Task 19） */
  accountOpen: boolean
  /** 快捷键帮助弹窗是否打开 */
  shortcutHelpOpen: boolean
  /** 关于弹窗是否打开（独立弹窗，由侧边栏下拉菜单触发） */
  aboutOpen: boolean
  /** 文件模糊搜索弹窗是否打开（⌘F 快捷键触发，对齐原型 fuzzy search overlay） */
  fuzzySearchOpen: boolean
  /** 反馈弹窗是否打开（Sidebar 下拉菜单触发，对齐原型 openFeedback） */
  feedbackOpen: boolean
  /** 检查更新弹窗是否打开（设置抽屉/菜单触发，对齐原型 openUpdater） */
  updateOpen: boolean

  /** 切换命令面板开关（键盘快捷键 Cmd/Ctrl+K 调用） */
  toggleCommandPalette: () => void
  /** 显式设置命令面板开关（命令面板项、菜单等调用） */
  setCommandPaletteOpen: (open: boolean) => void
  /** 切换偏好设置对话框开关 */
  togglePreferences: () => void
  /** 显式设置偏好设置对话框开关 */
  setPreferencesOpen: (open: boolean) => void
  /** 设置登录弹窗开关（登录入口和登录成功后调用） */
  setLoginOpen: (open: boolean) => void
  /** 设置账户信息弹窗开关（点击头像/账户按钮调用） */
  setAccountOpen: (open: boolean) => void
  /** 设置快捷键帮助弹窗开关（Help 菜单或 ? 快捷键调用） */
  setShortcutHelpOpen: (open: boolean) => void
  setAboutOpen: (open: boolean) => void
  /** 设置文件模糊搜索弹窗开关（⌘F 快捷键调用） */
  setFuzzySearchOpen: (open: boolean) => void
  /** 设置反馈弹窗开关（Sidebar 下拉菜单调用） */
  setFeedbackOpen: (open: boolean) => void
  /** 设置检查更新弹窗开关（设置抽屉/菜单调用） */
  setUpdateOpen: (open: boolean) => void
  /**
   * 一键关闭所有弹窗。
   * 用于 Esc 优先级链的终极兜底（如 Shift+Esc 一键清场），
   * 或路由切换、会话切换等需要清理所有弹窗状态的场景。
   */
  closeAllDialogs: () => void
}

/**
 * store 实现：所有对话框默认关闭。
 * toggle* 方法使用函数式 set 读取最新状态，避免闭包陈旧值。
 */
const dialogStoreCreator: StateCreator<
  DialogState,
  [['zustand/devtools', never]]
> = set => ({
  commandPaletteOpen: false,
  preferencesOpen: false,
  loginOpen: false,
  accountOpen: false,
  shortcutHelpOpen: false,
  aboutOpen: false,
  fuzzySearchOpen: false,
  feedbackOpen: false,
  updateOpen: false,

  toggleCommandPalette: () =>
    set(
      (state: DialogState) => ({
        commandPaletteOpen: !state.commandPaletteOpen,
      }),
      undefined,
      'toggleCommandPalette'
    ),

  setCommandPaletteOpen: (open: boolean) =>
    set({ commandPaletteOpen: open }, undefined, 'setCommandPaletteOpen'),

  togglePreferences: () =>
    set(
      (state: DialogState) => ({ preferencesOpen: !state.preferencesOpen }),
      undefined,
      'togglePreferences'
    ),

  setPreferencesOpen: (open: boolean) =>
    set({ preferencesOpen: open }, undefined, 'setPreferencesOpen'),

  setLoginOpen: (open: boolean) =>
    set({ loginOpen: open }, undefined, 'setLoginOpen'),

  setAccountOpen: (open: boolean) =>
    set({ accountOpen: open }, undefined, 'setAccountOpen'),

  setShortcutHelpOpen: (open: boolean) =>
    set({ shortcutHelpOpen: open }, undefined, 'setShortcutHelpOpen'),

  setAboutOpen: (open: boolean) =>
    set({ aboutOpen: open }, undefined, 'setAboutOpen'),

  setFuzzySearchOpen: (open: boolean) =>
    set({ fuzzySearchOpen: open }, undefined, 'setFuzzySearchOpen'),

  setFeedbackOpen: (open: boolean) =>
    set({ feedbackOpen: open }, undefined, 'setFeedbackOpen'),

  setUpdateOpen: (open: boolean) =>
    set({ updateOpen: open }, undefined, 'setUpdateOpen'),

  // 一键关闭所有弹窗：批量置 false，用于 Esc 优先级链兜底或路由切换清理。
  //
  // 范围说明（P2 修复补充）：
  //  - 本方法仅关闭 dialog-store 自身管理的弹窗状态
  //    （命令面板 / 偏好 / 登录 / 账户 / 快捷键帮助 / 关于 / 模糊搜索 / 反馈 / 更新）。
  //  - 不包含其他 store 管理的弹窗与抽屉（如 terminal-store、thread-store），
  //    也未覆盖 MainWindow 本地状态控制的抽屉（抽屉非本 store 职责）。
  //  - 需要跨 store 统一关闭时，应由 LayerManager.closeAll() 协调
  //    （见 layer-manager-context.tsx：通过层级栈从栈顶到栈底依次调用各层 close，
  //     涵盖 Radix 弹窗与抽屉），避免在此处直接 import 其他 store 造成循环依赖
  //    与 store 间高耦合。
  closeAllDialogs: () =>
    set(
      {
        commandPaletteOpen: false,
        preferencesOpen: false,
        loginOpen: false,
        accountOpen: false,
        shortcutHelpOpen: false,
        aboutOpen: false,
        fuzzySearchOpen: false,
        feedbackOpen: false,
        updateOpen: false,
      },
      undefined,
      'closeAllDialogs'
    ),
})

/**
 * 全局对话框状态 store 单例。
 *
 * 使用方式：
 *  - React 组件：`const open = useDialogStore(s => s.preferencesOpen)`
 *  - 非 React 模块（菜单、命令等）：`useDialogStore.getState().setPreferencesOpen(true)`
 */
export const useDialogStore = create<DialogState>()(
  devtools(dialogStoreCreator, {
    name: 'dialog-store',
  })
)
