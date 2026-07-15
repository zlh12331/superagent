/**
 * @file 应用级命令集合。
 *
 * 职责：声明与命令面板等应用级动作相关的命令。
 *
 * 当前仅包含 toggle-command-palette，未来可扩展如 toggle-fullscreen、
 *   reload-window 等全局动作。
 */

import { Command } from 'lucide-react'
import { useDialogStore } from '@/store/dialog-store'
import type { AppCommand } from './types'

/**
 * 应用级命令数组，供 registry 注册。
 */
export const appCommands: AppCommand[] = [
  {
    id: 'toggle-command-palette',
    labelKey: 'commands.toggleCommandPalette.label',
    descriptionKey: 'commands.toggleCommandPalette.description',
    icon: Command,
    group: 'tools',
    shortcut: '⌘+K',
    keywords: ['command', 'palette', 'cmdk', 'k', 'toggle', 'open'],

    execute: () => {
      useDialogStore.getState().toggleCommandPalette()
    },
  },
]
