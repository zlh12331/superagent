/**
 * @file sidebar 显隐状态的 Zustand store。
 *
 * 职责：管理左右 sidebar 的可见性，并提供 set/toggle 两类方法
 *   分别用于命令面板（set*）与键盘快捷键（toggle*）。
 *
 * 默认值：左右均可见（true）。
 *
 * 不持久化：sidebar 状态由用户当前会话需求决定，无需跨会话保留。
 */

import { create, type StateCreator } from 'zustand'
import { devtools } from 'zustand/middleware'

/**
 * Sidebar store 状态接口。
 *
 * 字段说明：
 *  - leftSidebarVisible   左侧 sidebar（线程列表/文件树）是否可见
 *  - rightSidebarVisible  右侧 sidebar（终端/上下文）是否可见
 */
export interface SidebarState {
  /** 左侧 sidebar 是否可见（线程列表/文件树区域） */
  leftSidebarVisible: boolean
  /** 右侧 sidebar 是否可见（终端/上下文区域） */
  rightSidebarVisible: boolean

  /** 切换左侧 sidebar 显隐（键盘快捷键 Cmd/Ctrl+B 调用） */
  toggleLeftSidebar: () => void
  /** 显式设置左侧 sidebar 显隐（菜单项、命令面板等调用） */
  setLeftSidebarVisible: (visible: boolean) => void
  /** 切换右侧 sidebar 显隐（键盘快捷键调用） */
  toggleRightSidebar: () => void
  /** 显式设置右侧 sidebar 显隐（菜单项、命令面板等调用） */
  setRightSidebarVisible: (visible: boolean) => void
}

/**
 * store 实现：默认两侧均可见。
 * toggle* 使用函数式 set 读取最新值，避免 React 事件中闭包陈旧。
 */
const sidebarStoreCreator: StateCreator<
  SidebarState,
  [['zustand/devtools', never]]
> = set => ({
  leftSidebarVisible: true,
  rightSidebarVisible: true,

  toggleLeftSidebar: () =>
    set(
      (state: SidebarState) => ({
        leftSidebarVisible: !state.leftSidebarVisible,
      }),
      undefined,
      'toggleLeftSidebar'
    ),

  setLeftSidebarVisible: (visible: boolean) =>
    set({ leftSidebarVisible: visible }, undefined, 'setLeftSidebarVisible'),

  toggleRightSidebar: () =>
    set(
      (state: SidebarState) => ({
        rightSidebarVisible: !state.rightSidebarVisible,
      }),
      undefined,
      'toggleRightSidebar'
    ),

  setRightSidebarVisible: (visible: boolean) =>
    set({ rightSidebarVisible: visible }, undefined, 'setRightSidebarVisible'),
})

/**
 * 全局 sidebar 状态 store 单例。
 *
 * 使用方式：
 *  - React 组件：`const visible = useSidebarStore(s => s.leftSidebarVisible)`
 *  - 非 React 模块：`useSidebarStore.getState().toggleLeftSidebar()`
 */
export const useSidebarStore = create<SidebarState>()(
  devtools(sidebarStoreCreator, {
    name: 'sidebar-store',
  })
)
