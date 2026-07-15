/**
 * @file 导航类命令集合。
 *
 * 职责：声明与 sidebar 显隐、偏好设置打开相关的命令。
 *
 * 命令清单：
 *  - show-left-sidebar / hide-left-sidebar / toggle-left-sidebar
 *  - show-right-sidebar / hide-right-sidebar / toggle-right-sidebar
 *  - open-preferences
 *
 * 注意：sidebar 状态直接通过 Zustand store 的 getState() 读写，
 *   不依赖 React 上下文，便于在菜单与快捷键中触发。
 */

import { Sidebar, PanelRight, Settings } from 'lucide-react'
import { useSidebarStore } from '@/store/sidebar-store'
import type { AppCommand } from './types'

/**
 * 导航类命令数组，供 registry 注册。
 * 同一动作的 show/hide/toggle 分开声明，便于在命令面板根据当前可见状态过滤展示。
 */
export const navigationCommands: AppCommand[] = [
  {
    id: 'show-left-sidebar',
    labelKey: 'commands.showLeftSidebar.label',
    descriptionKey: 'commands.showLeftSidebar.description',
    icon: Sidebar,
    group: 'navigation',
    shortcut: '⌘+1',
    keywords: ['sidebar', 'left', 'panel', 'show'],

    execute: () => {
      useSidebarStore.getState().setLeftSidebarVisible(true)
    },

    isAvailable: () => !useSidebarStore.getState().leftSidebarVisible,
  },

  {
    id: 'hide-left-sidebar',
    labelKey: 'commands.hideLeftSidebar.label',
    descriptionKey: 'commands.hideLeftSidebar.description',
    icon: Sidebar,
    group: 'navigation',
    shortcut: '⌘+1',
    keywords: ['sidebar', 'left', 'panel', 'hide'],

    execute: () => {
      useSidebarStore.getState().setLeftSidebarVisible(false)
    },

    isAvailable: () => useSidebarStore.getState().leftSidebarVisible,
  },

  {
    id: 'show-right-sidebar',
    labelKey: 'commands.showRightSidebar.label',
    descriptionKey: 'commands.showRightSidebar.description',
    icon: PanelRight,
    group: 'navigation',
    shortcut: '⌘+2',
    keywords: ['sidebar', 'right', 'panel', 'show'],

    execute: () => {
      useSidebarStore.getState().setRightSidebarVisible(true)
    },

    isAvailable: () => !useSidebarStore.getState().rightSidebarVisible,
  },

  {
    id: 'hide-right-sidebar',
    labelKey: 'commands.hideRightSidebar.label',
    descriptionKey: 'commands.hideRightSidebar.description',
    icon: PanelRight,
    group: 'navigation',
    shortcut: '⌘+2',
    keywords: ['sidebar', 'right', 'panel', 'hide'],

    execute: () => {
      useSidebarStore.getState().setRightSidebarVisible(false)
    },

    isAvailable: () => useSidebarStore.getState().rightSidebarVisible,
  },

  {
    id: 'open-preferences',
    labelKey: 'commands.openPreferences.label',
    descriptionKey: 'commands.openPreferences.description',
    icon: Settings,
    group: 'settings',
    shortcut: '⌘+,',
    keywords: ['preferences', 'settings', 'config', 'options'],

    execute: context => {
      context.openPreferences()
    },
  },

  {
    id: 'toggle-left-sidebar',
    labelKey: 'commands.toggleLeftSidebar.label',
    descriptionKey: 'commands.toggleLeftSidebar.description',
    icon: Sidebar,
    group: 'navigation',
    shortcut: '⌘+1',
    keywords: ['sidebar', 'left', 'panel', 'toggle'],

    execute: () => {
      useSidebarStore.getState().toggleLeftSidebar()
    },
  },

  {
    id: 'toggle-right-sidebar',
    labelKey: 'commands.toggleRightSidebar.label',
    descriptionKey: 'commands.toggleRightSidebar.description',
    icon: PanelRight,
    group: 'navigation',
    shortcut: '⌘+2',
    keywords: ['sidebar', 'right', 'panel', 'toggle'],

    execute: () => {
      useSidebarStore.getState().toggleRightSidebar()
    },
  },
]
