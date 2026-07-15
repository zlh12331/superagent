/**
 * @file 应用级 UI 状态的 Zustand store。
 *
 * 职责：保存不属于特定业务域的全局 UI 偏好与临时状态，包括：
 *  - lastQuickPaneEntry  快捷面板最近一次输入文本（用于回填）
 *  - squareCorners        是否禁用圆角（Windows/Linux 全屏时使用）
 *
 * 不持久化：这些状态属于会话级临时偏好，重启后重置为默认值即可。
 */

import { create, type StateCreator } from 'zustand'
import { devtools } from 'zustand/middleware'

/**
 * UI store 状态接口。
 *
 * 字段说明：
 *  - lastQuickPaneEntry  最近一次通过快捷面板提交的文本，便于下次打开时回填
 *  - squareCorners        为 true 时全局组件使用直角样式，常用于 Windows/Linux 全屏
 */
export interface UIState {
  /** 最近一次通过快捷面板提交的文本（用于下次打开时回填，提升复用效率） */
  lastQuickPaneEntry: string | null
  /** 为 true 时全局组件使用直角样式（Windows/Linux 全屏时使用，避免圆角与系统边框冲突） */
  squareCorners: boolean

  /** 设置最近一次快捷面板输入文本（提交后调用） */
  setLastQuickPaneEntry: (text: string) => void
  /** 设置是否启用直角样式（由 useSquareCornersEffect hook 根据平台和窗口状态调用） */
  setSquareCorners: (enabled: boolean) => void
}

/**
 * store 实现：默认 lastQuickPaneEntry 为 null、squareCorners 关闭。
 * 通过 devtools 中间件暴露 action 名便于调试。
 */
const uiStoreCreator: StateCreator<
  UIState,
  [['zustand/devtools', never]]
> = set => ({
  lastQuickPaneEntry: null,
  squareCorners: false,

  setLastQuickPaneEntry: (text: string) =>
    set({ lastQuickPaneEntry: text }, undefined, 'setLastQuickPaneEntry'),

  setSquareCorners: (enabled: boolean) => {
    set({ squareCorners: enabled }, undefined, 'setSquareCorners')
  },
})

/**
 * 全局 UI 状态 store 单例。
 *
 * 使用方式：
 *  - React 组件：`const squareCorners = useUIStore(s => s.squareCorners)`
 *  - 非 React 模块：`useUIStore.getState().setSquareCorners(true)`
 *
 * @see src/hooks/useSquareCornersEffect.ts — 监听窗口状态并调用 setSquareCorners
 */
export const useUIStore = create<UIState>()(
  devtools(uiStoreCreator, {
    name: 'ui-store',
  })
)
