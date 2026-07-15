/**
 * Thread Store — Zustand（纯 UI 状态）
 *
 * 状态管理决策树位置：
 *   useState → Zustand → TanStack Query
 *   线程列表（服务端持久化数据）已迁移到 TanStack Query（src/queries/threads.ts），
 *   本 store 仅保留纯 UI 状态：活跃线程 ID、侧栏标签、搜索词、折叠文件夹。
 *
 * 迁移说明：
 *   - threads / isLoading / setThreads / addThread / removeThread / archiveThread /
 *     unarchiveThread / renameThread / getFilteredThreads / getThreadFolders / getCounts
 *     已移除，由 useThreads hook + useMutation 钩子替代
 *   - getThreadState 已移除，UI 层可直接从 useThreads 的 data 中判断
 *   - 保留 activeThreadId / activeTab / searchQuery / collapsedFolders 及对应 setter
 */

import { create, type StateCreator } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { ThreadId } from '@/lib/codex/types'

/**
 * 侧边栏标签 —— 决定显示哪个线程分组。
 * - 'recent'   最近会话（未归档）
 * - 'archived' 已归档会话
 */
export type SidebarTab = 'recent' | 'archived'

export interface ThreadStoreState {
  /** 当前活跃线程 ID（null 表示未选中线程 / 显示欢迎屏） */
  activeThreadId: ThreadId | null
  /** 当前侧边栏标签 */
  activeTab: SidebarTab
  /** 用于过滤线程的搜索词（实时匹配线程标题/内容） */
  searchQuery: string
  /** 已折叠的文件夹名称集合（按文件夹名索引，UI 渲染时查询） */
  collapsedFolders: Set<string>
  /**
   * 待创建会话的文件夹（对齐原型 pendingFolder）。
   *
   * 用户点击「新建会话」时记录当前活跃会话的 folder，
   * 欢迎页发送首条消息创建会话时读取并继承此 folder。
   * 创建完成后立即清空（null），避免污染后续手动创建。
   */
  pendingFolder: string | null

  /**
   * 设置当前活跃线程 ID。
   * 切换线程时同时触发 TanStack Query 中 messages 的查询切换（通过 activeThreadId 依赖）。
   */
  setActiveThread: (threadId: ThreadId | null) => void
  /** 切换侧边栏标签（recent / archived） */
  setActiveTab: (tab: SidebarTab) => void
  /** 设置搜索词（输入框 onChange 实时调用） */
  setSearchQuery: (query: string) => void
  /** 切换文件夹折叠状态（点击文件夹头部时调用） */
  toggleFolder: (folder: string) => void
  /** 清空所有文件夹的折叠状态（搜索时调用以保证匹配项可见） */
  clearCollapsedFolders: () => void
  /** 设置待创建会话的文件夹（新建会话时继承当前会话 folder） */
  setPendingFolder: (folder: string | null) => void
}

/**
 * store 实现：纯 UI 状态，不持久化（重启后回到默认值）。
 * collapsedFolders 使用 Set 而非 Record，因为只关心"是否折叠"的布尔语义。
 */
const threadStoreCreator: StateCreator<
  ThreadStoreState,
  [['zustand/devtools', never]]
> = (set) => ({
  activeThreadId: null,
  activeTab: 'recent',
  searchQuery: '',
  collapsedFolders: new Set<string>(),
  pendingFolder: null,

  setActiveThread: threadId =>
    set({ activeThreadId: threadId }, undefined, 'setActiveThread'),

  setActiveTab: tab => set({ activeTab: tab }, undefined, 'setActiveTab'),

  setSearchQuery: query =>
    set({ searchQuery: query }, undefined, 'setSearchQuery'),

  // 函数式 set：每次创建新 Set 实例，保证引用变更触发组件重渲染
  toggleFolder: folder =>
    set(
      state => {
        const next = new Set(state.collapsedFolders)
        if (next.has(folder)) {
          next.delete(folder)
        } else {
          next.add(folder)
        }
        return { collapsedFolders: next }
      },
      undefined,
      'toggleFolder'
    ),

  // 搜索时需要展开所有文件夹，直接创建空 Set 保证引用变更触发重渲染
  clearCollapsedFolders: () =>
    set(
      { collapsedFolders: new Set<string>() },
      undefined,
      'clearCollapsedFolders'
    ),

  setPendingFolder: folder =>
    set({ pendingFolder: folder }, undefined, 'setPendingFolder'),
})

/**
 * 全局线程 UI 状态 store 单例。
 *
 * 注意：本 store 仅保存纯 UI 状态，业务数据（线程列表）由 TanStack Query 管理。
 * 使用方式：
 *  - React 组件：`const activeId = useThreadStore(s => s.activeThreadId)`
 *  - 非 React 模块：`useThreadStore.getState().setActiveThread(id)`
 *
 * @see src/queries/threads.ts — 线程列表查询（业务数据来源）
 * @see src/queries/messages.ts — 消息查询（依赖 activeThreadId）
 */
export const useThreadStore = create<ThreadStoreState>()(
  devtools(threadStoreCreator, {
    name: 'thread-store',
  })
)
