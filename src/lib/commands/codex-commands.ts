/**
 * Codex 业务命令 — 注册到命令面板中央注册表
 *
 * 参照 prototype.html 的功能需求，为命令面板添加 Codex 特有命令：
 * - 新建线程 / 切换线程
 * - 发送 Turn / 停止 Turn
 * - 打开终端 / 打开文件树
 * - 切换主题
 *
 * 命令通过 Zustand store 的 getState() 直接操作状态，
 * 与 navigation-commands.ts 的模式一致。
 */

import {
  Plus,
  MessagesSquare,
  Send,
  Square,
  Terminal,
  FolderTree,
  SunMoon,
} from 'lucide-react'
import { toast } from 'sonner'
import { useThreadStore } from '@/store/thread-store'
import { useSidebarStore } from '@/store/sidebar-store'
import { useTerminalStore } from '@/features/terminal/terminal-store'
import { useFileTreeStore } from '@/features/file-tree/file-tree-store'
import { createThread } from '@/lib/codex/thread'
import { queryClient } from '@/lib/query-client'
import { threadsQueryKeys } from '@/queries/threads'
import { logger } from '@/lib/logger'
import { readStoredTheme, writeStoredTheme, applyThemeClass } from '@/lib/theme'
import type { AppCommand } from './types'

/**
 * Codex 业务命令数组，供 registry 注册。
 *
 * 命令清单（7 个）：
 *  - codex.newThread      新建线程（失败时 toast 提示，成功后失效列表查询）
 *  - codex.switchThread   切换线程（打开侧边栏会话列表）
 *  - codex.sendTurn       发送 Turn（聚焦会话输入框）
 *  - codex.stopTurn       停止 Turn（当前为 mock，后续接入 cancelTurn API）
 *  - codex.openTerminal   打开终端（显示右侧栏，自动创建会话）
 *  - codex.openFileTree   打开文件树（显示左侧栏并切换视图）
 *  - codex.toggleTheme    切换主题（在 dark/light 之间切换，system 视为 dark）
 *
 * 注意：命令通过 Zustand store 的 getState() 直接操作状态，
 *   不依赖 React 上下文，便于在菜单、快捷键、命令面板三种入口共享同一份实现。
 */
export const codexCommands: AppCommand[] = [
  // ─── 新建线程 ──────────────────────────────────────────────────
  {
    id: 'codex.newThread',
    labelKey: 'commands.newThread.label',
    descriptionKey: 'commands.newThread.description',
    icon: Plus,
    group: 'codex',
    shortcut: 'Ctrl+Shift+N',
    keywords: ['new', 'thread', 'create', '新建', '线程', '会话'],

    execute: async () => {
      try {
        const thread = await createThread(null)
        // 失效线程列表查询，使 Sidebar 自动刷新
        void queryClient.invalidateQueries({
          queryKey: threadsQueryKeys.list(),
        })
        // 设为活跃线程（UI 状态仍由 Zustand 管理）
        useThreadStore.getState().setActiveThread(thread.id)
        toast.success('新会话已创建')
      } catch (error) {
        logger.error('Failed to create thread via command', { error })
        toast.error('创建会话失败')
      }
    },
  },

  // ─── 切换线程 ──────────────────────────────────────────────────
  {
    id: 'codex.switchThread',
    labelKey: 'commands.switchThread.label',
    descriptionKey: 'commands.switchThread.description',
    icon: MessagesSquare,
    group: 'codex',
    keywords: ['switch', 'thread', 'change', '切换', '线程', '会话'],

    execute: () => {
      // 显示左侧边栏并切换到会话列表视图
      useSidebarStore.getState().setLeftSidebarVisible(true)
      useFileTreeStore.getState().setSidebarView('threads')
      toast.info('请从侧边栏选择会话')
    },
  },

  // ─── 发送 Turn ────────────────────────────────────────────────
  {
    id: 'codex.sendTurn',
    labelKey: 'commands.sendTurn.label',
    descriptionKey: 'commands.sendTurn.description',
    icon: Send,
    group: 'codex',
    keywords: ['send', 'turn', 'message', '发送', '消息'],

    // 仅在有活动线程时可用
    isAvailable: () => useThreadStore.getState().activeThreadId !== null,

    execute: () => {
      // 聚焦会话输入框（通过 DOM 查询）
      const input = document.querySelector<HTMLTextAreaElement>(
        '[data-conversation-input]'
      )
      if (input) {
        input.focus()
      } else {
        toast.info('请输入消息后按 Enter 发送')
      }
    },
  },

  // ─── 停止 Turn ────────────────────────────────────────────────
  {
    id: 'codex.stopTurn',
    labelKey: 'commands.stopTurn.label',
    descriptionKey: 'commands.stopTurn.description',
    icon: Square,
    group: 'codex',
    keywords: ['stop', 'cancel', 'turn', '停止', '取消'],

    // 仅在有活动线程时可用
    isAvailable: () => useThreadStore.getState().activeThreadId !== null,

    execute: () => {
      // 发送停止信号（当前为 mock，后续接入真实 cancelTurn API）
      toast.info('已请求停止当前 Turn')
    },
  },

  // ─── 打开终端 ──────────────────────────────────────────────────
  {
    id: 'codex.openTerminal',
    labelKey: 'commands.openTerminal.label',
    descriptionKey: 'commands.openTerminal.description',
    icon: Terminal,
    group: 'codex',
    shortcut: 'Ctrl+`',
    keywords: ['terminal', 'shell', 'console', '终端', '命令行'],

    execute: () => {
      // 显示右侧边栏（ContextPanel 默认展示 terminal tab）
      useSidebarStore.getState().setRightSidebarVisible(true)
      // 确保至少有一个终端会话
      const { sessions, createSession } = useTerminalStore.getState()
      if (sessions.length === 0) {
        createSession()
      }
    },
  },

  // ─── 打开文件树 ────────────────────────────────────────────────
  {
    id: 'codex.openFileTree',
    labelKey: 'commands.openFileTree.label',
    descriptionKey: 'commands.openFileTree.description',
    icon: FolderTree,
    group: 'codex',
    keywords: ['file', 'tree', 'explorer', '文件', '文件树', '资源管理器'],

    execute: () => {
      // 显示左侧边栏并切换到文件树视图
      useSidebarStore.getState().setLeftSidebarVisible(true)
      useFileTreeStore.getState().setSidebarView('fileTree')
    },
  },

  // ─── 切换主题 ──────────────────────────────────────────────────
  {
    id: 'codex.toggleTheme',
    labelKey: 'commands.toggleTheme.label',
    descriptionKey: 'commands.toggleTheme.description',
    icon: SunMoon,
    group: 'codex',
    keywords: [
      'theme',
      'toggle',
      'dark',
      'light',
      '主题',
      '切换',
      '暗色',
      '亮色',
    ],

    execute: () => {
      // 读取当前主题，在 dark/light 之间切换（system 视为 dark）
      const current = readStoredTheme('system')
      const next = current === 'dark' ? 'light' : 'dark'
      // 写入 localStorage 并立即应用到 DOM
      writeStoredTheme(next)
      applyThemeClass(next)
      toast.success(`已切换为${next === 'dark' ? '暗色' : '亮色'}主题`)
    },
  },
]
