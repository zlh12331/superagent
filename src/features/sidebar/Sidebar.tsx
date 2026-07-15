/**
 * Sidebar — 左侧栏（含会话列表）
 *
 * 对应 prototype.html `<aside class="sidebar">`（第 5105-5266 行）：
 * - 头部：新建会话按钮 + 搜索框 + 标签页（最近 / 已归档）
 * - 列表：按文件夹分组、会话项、空状态
 * - 底部：账户触发器 + 下拉菜单
 *
 * 状态管理分层：
 *   - 服务端数据（线程列表）通过 TanStack Query 管理（useThreads / useMutation）
 *   - 纯 UI 状态（activeTab、searchQuery、collapsedFolders）通过 Zustand 管理
 *   - 活跃线程 ID 通过 Zustand 管理（跨组件共享，控制 ConversationArea 显示）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus,
  Search,
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  User,
  Settings,
  MessageSquare,
  Info,
  LogOut,
  Pin,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { useThreadStore, type SidebarTab } from '@/store/thread-store'
import {
  useThreads,
  useCreateThread,
  useDeleteThread,
  useArchiveThread,
  useRenameThread,
  useForkThread,
  useSetThreadPinned,
} from '@/queries/threads'
import type { Thread } from '@/lib/codex/types'
import { cn } from '@/lib/utils'
import { FileTree, useFileTreeStore } from '@/features/file-tree'
// 命令式确认对话框 — 对齐原型 showConfirmDialog（替换 window.confirm）
import { confirm } from '@/features/dialog'
import { ThreadItem } from './ThreadItem'
import {
  ThreadContextMenu,
  type ContextMenuPosition,
} from './ThreadContextMenu'

// 模块级空数组常量 — useThreads 初次加载 data 为 undefined 时回退，
// 避免每次渲染创建新数组引用导致下游 useMemo 失效
const EMPTY_THREADS: Thread[] = []

/**
 * Sidebar 组件属性。
 *
 * 所有回调均为可选，由父组件按需提供；缺省时对应菜单项不触发动作。
 */
export interface SidebarProps {
  /** 打开设置抽屉回调 */
  onOpenSettings?: () => void
  /** 打开账户信息对话框回调 */
  onOpenAccount?: () => void
  /** 打开反馈对话框回调 */
  onOpenFeedback?: () => void
  /** 打开关于对话框回调 */
  onOpenAbout?: () => void
  /** 退出登录 — 由父组件对接 LoginDialog 或登出逻辑 */
  onLogout?: () => void
}

/**
 * Sidebar 组件 —— 应用左侧栏。
 *
 * 渲染层次：
 *  - 顶部：新建会话按钮 + 搜索框 + 最近/归档 tab 切换
 *  - 主体：按文件夹分组的会话列表（可折叠）+ 无文件夹会话
 *  - 底部：账户触发器 + 下拉菜单（账户/设置/反馈/关于/退出）
 *  - 切换：通过 sidebarView 可切换到 FileTree 视图
 *
 * 状态依赖：
 *  - 服务端数据通过 TanStack Query（useThreads + 5 个 useMutation）管理
 *  - 纯 UI 状态（activeTab/searchQuery/collapsedFolders/activeThreadId）通过 useThreadStore
 *  - sidebarView 通过 useFileTreeStore 与 file-tree feature 共享
 *  - 本地 useState 管理 dropdownOpen / ctxMenu / archivedCollapsed
 *
 * 副作用：
 *  - dropdownOpen 时注册 document mousedown 监听，点击外部关闭下拉
 *  - 创建/删除/归档/重命名/复制会话通过 mutation 触发，自动乐观更新与缓存失效
 *
 * 设计决策：
 *  - SidebarProps 全部回调可选，便于在不同宿主组件中复用
 *  - 文件夹分组和无文件夹会话分别渲染，便于按文件夹折叠
 *  - 归档列表支持清空操作（批量调用 deleteThreadMutation）
 *
 * @param props —— 见 SidebarProps 接口
 */
export function Sidebar({
  onOpenSettings,
  onOpenAccount,
  onOpenFeedback,
  onOpenAbout,
  onLogout,
}: SidebarProps) {
  // ---- 纯 UI 状态（Zustand）----
  const activeThreadId = useThreadStore(s => s.activeThreadId)
  const activeTab = useThreadStore(s => s.activeTab)
  const searchQuery = useThreadStore(s => s.searchQuery)
  const collapsedFolders = useThreadStore(s => s.collapsedFolders)
  const setActiveThread = useThreadStore(s => s.setActiveThread)
  const setActiveTab = useThreadStore(s => s.setActiveTab)
  const setSearchQuery = useThreadStore(s => s.setSearchQuery)
  const toggleFolder = useThreadStore(s => s.toggleFolder)
  const clearCollapsedFolders = useThreadStore(s => s.clearCollapsedFolders)
  const setPendingFolder = useThreadStore(s => s.setPendingFolder)

  // ---- 服务端数据（TanStack Query）----
  // useThreads 自动管理 loading、缓存、重试、stale-while-revalidate
  const { data: threads = EMPTY_THREADS, isLoading } = useThreads()

  // 突变钩子（内部已处理乐观更新、错误回滚、toast 提示）
  const createThreadMutation = useCreateThread()
  const deleteThreadMutation = useDeleteThread()
  const archiveThreadMutation = useArchiveThread()
  const renameThreadMutation = useRenameThread()
  const forkThreadMutation = useForkThread()
  const setThreadPinnedMutation = useSetThreadPinned()

  const [dropdownOpen, setDropdownOpen] = useState(false)
  // 账户菜单外层容器引用 — 用于"点击外部关闭下拉菜单"判定
  const accountRef = useRef<HTMLDivElement>(null)

  // H1: 置顶会话 ID 集合 —— 从 threads 缓存派生（单一真相源：thread.metadata.pinned）
  // 不再用 localStorage 持久化，改为以服务端 metadata.pinned 为准。
  // 操作时通过 useSetThreadPinned mutation 乐观更新缓存，pinnedIds 自动跟随变化。
  const pinnedIds = useMemo(
    () => new Set(threads.filter(t => t.metadata.pinned).map(t => t.id)),
    [threads]
  )

  // 点击账户菜单外部时关闭下拉（对齐原型 line 13141-13150 的 document 监听逻辑）
  useEffect(() => {
    if (!dropdownOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (
        accountRef.current &&
        !accountRef.current.contains(e.target as Node)
      ) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [dropdownOpen])

  // P1-6: 搜索时自动展开所有折叠的文件夹，保证匹配项可见
  // 仅在搜索词非空时清空折叠状态；搜索清空时不主动收起，保留用户后续手动操作
  useEffect(() => {
    if (searchQuery.trim() !== '') {
      clearCollapsedFolders()
    }
  }, [searchQuery, clearCollapsedFolders])

  const [ctxMenu, setCtxMenu] = useState<{
    position: ContextMenuPosition
    threadId: string
  } | null>(null)
  // 右键菜单「重命名」触发的线程 ID —— 非 null 时对应 ThreadItem 进入内联重命名模式。
  // 重命名结束（提交或取消）后由 ThreadItem 的 onRenameEnd 回调清除。
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null)
  // 分组收起状态：已归档分组可收起（含"清空"操作按钮）
  // 最近 tab 无标题栏，不需要折叠状态
  const [archivedCollapsed, setArchivedCollapsed] = useState(false)
  // I-S-001 + P1-10/11: 搜索匹配高亮的会话 ID 集合
  // 对齐原型 prototype.html L11842-11878：
  //   - 300ms 防抖后计算匹配项并高亮（非即时，对齐原型 debounce 300ms）
  //   - 高亮 2 秒后自动清除（闪烁效果，对齐原型 setTimeout(() => outline='', 2000)）
  //   - 少于 2 字符不高亮（对齐原型 if (q.length < 2) return）
  // 即时过滤（filteredThreads）不受影响，保持输入响应性
  const [highlightedThreadIds, setHighlightedThreadIds] = useState<Set<string>>(
    () => new Set()
  )
  // 高亮过期定时器引用 — 新的防抖触发时清除之前的过期定时器，避免叠加
  const highlightExpireTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )

  // P3 修复：通过 ref 读取最新 threads，避免将 threads 放入 effect 依赖。
  // 此前 threads 变化（如缓存刷新、乐观更新回写）会重置防抖计时器，导致用户
  // 输入过程中的高亮计算被反复打断。改为 ref 读取后，effect 仅依赖 searchQuery，
  // 防抖窗口稳定；计时器触发时仍能读到最新的 threads。
  const threadsRef = useRef(threads)
  // 在 effect 中同步 ref —— react-hooks/refs 规则禁止在渲染阶段写入 ref.current。
  // 该 effect 在 threads 变化后立即（微秒级）更新 ref，远早于 300ms 防抖触发，
  // 保证防抖计时器触发时读取到最新的会话列表。
  useEffect(() => {
    threadsRef.current = threads
  }, [threads])

  useEffect(() => {
    const q = searchQuery.trim().toLowerCase()

    // 300ms 防抖后计算匹配项（对齐原型 setTimeout(..., 300)）
    const debounceTimer = setTimeout(() => {
      // 少于 2 字符不高亮（对齐原型 q.length < 2 检查）
      // 不主动清除——让之前的高亮自然过期（对齐原型行为）
      if (q.length < 2) return

      const matched = new Set<string>()
      // 用 threadsRef.current 读取最新会话列表，避免将其加入依赖而打断防抖
      for (const t of threadsRef.current) {
        if (
          t.title.toLowerCase().includes(q) ||
          (t.cwd !== null && t.cwd.toLowerCase().includes(q))
        ) {
          matched.add(t.id)
        }
      }
      setHighlightedThreadIds(matched)

      // 清除之前的过期定时器（避免多次搜索叠加）
      if (highlightExpireTimerRef.current !== null) {
        clearTimeout(highlightExpireTimerRef.current)
      }
      // 2 秒后自动清除高亮（对齐原型 setTimeout(() => { item.style.outline = ''; }, 2000)）
      highlightExpireTimerRef.current = setTimeout(() => {
        setHighlightedThreadIds(new Set())
        highlightExpireTimerRef.current = null
      }, 2000)
    }, 300)

    return () => clearTimeout(debounceTimer)
    // 仅依赖 searchQuery；threads 通过 ref 读取，避免防抖被打断
  }, [searchQuery])

  // 组件卸载时清除过期定时器，防止内存泄漏
  useEffect(() => {
    return () => {
      if (highlightExpireTimerRef.current !== null) {
        clearTimeout(highlightExpireTimerRef.current)
        highlightExpireTimerRef.current = null
      }
    }
  }, [])

  // 文件树视图切换状态（与 file-tree feature 共享 store）
  const sidebarView = useFileTreeStore(s => s.sidebarView)
  const setSidebarView = useFileTreeStore(s => s.setSidebarView)

  // ---- 派生数据 ----
  const filteredThreads = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return threads.filter(t => {
      const tabMatch = activeTab === 'archived' ? t.archived : !t.archived
      if (!tabMatch) return false
      if (!q) return true
      return (
        t.title.toLowerCase().includes(q) ||
        (t.cwd !== null && t.cwd.toLowerCase().includes(q))
      )
    })
  }, [threads, activeTab, searchQuery])

  // H1: 置顶会话 —— 仅 recent tab 显示，从 filteredThreads 中提取命中 pinnedIds 的项。
  // archived tab 不显示置顶（归档会话已不活跃）
  const pinnedThreads = useMemo(() => {
    if (activeTab !== 'recent') return []
    return filteredThreads.filter(t => pinnedIds.has(t.id))
  }, [filteredThreads, pinnedIds, activeTab])

  // 非置顶会话 —— 从 filteredThreads 中排除置顶项，用于文件夹分组和无文件夹列表渲染
  const nonPinnedThreads = useMemo(
    () => filteredThreads.filter(t => !pinnedIds.has(t.id)),
    [filteredThreads, pinnedIds]
  )

  const folders = useMemo(() => {
    const set = new Set<string>()
    for (const t of nonPinnedThreads) {
      if (t.metadata.folder !== null) {
        set.add(t.metadata.folder)
      }
    }
    return Array.from(set).sort()
  }, [nonPinnedThreads])

  const threadsWithoutFolder = useMemo(
    () => nonPinnedThreads.filter(t => t.metadata.folder === null),
    [nonPinnedThreads]
  )

  const threadsByFolder = useMemo(() => {
    const map = new Map<string, Thread[]>()
    for (const t of nonPinnedThreads) {
      const folder = t.metadata.folder
      if (folder === null) continue
      const arr = map.get(folder)
      if (arr) {
        arr.push(t)
      } else {
        map.set(folder, [t])
      }
    }
    return map
  }, [nonPinnedThreads])

  const counts = useMemo(() => {
    let recent = 0
    let archived = 0
    for (const t of threads) {
      if (t.archived) archived++
      else recent++
    }
    return { recent, archived }
  }, [threads])

  // ---- 事件处理 ----
  // H2: 延迟创建策略 —— 点击「新建会话」时不立即调用后端创建线程，
  // 而是切换到欢迎页（activeThreadId = null），让用户在对话区输入首条消息后
  // 再由 ConversationArea 触发实际创建。这样做的好处：
  // 1. 避免创建大量空线程（用户点「新建」但未输入内容就切换走）
  // 2. 线程标题可基于首条消息自动生成，无需用户手动命名
  // 3. 减少不必要的后端请求
  //
  // P1-6: 文件夹继承 — 对齐原型 L10897: `folder = pendingFolder`
  // 点击「新建会话」时记录当前活跃会话的 folder 到 pendingFolder，
  // 欢迎页发送首条消息创建会话时读取并继承此 folder。
  const handleCreateThread = useCallback(() => {
    // 查找当前活跃会话的 folder（对齐原型 getThreadFolder）
    const activeThread = threads.find(t => t.id === activeThreadId)
    setPendingFolder(activeThread?.metadata.folder ?? null)
    setActiveThread(null)
    // 清空搜索词，确保新会话界面不被过滤
    setSearchQuery('')
  }, [threads, activeThreadId, setPendingFolder, setActiveThread, setSearchQuery])

  // 在指定文件夹内新建会话 — 对齐原型 .fl-add-btn 的点击行为
  // 与 handleCreateThread 的区别：metadata 带 folder，使新会话归入该文件夹
  const handleCreateThreadInFolder = useCallback(
    async (folder: string) => {
      const thread = await createThreadMutation.mutateAsync({
        cwd: null,
        metadata: { title: '新会话', folder },
      })
      setActiveThread(thread.id)
    },
    [createThreadMutation, setActiveThread]
  )

  const handleSelectThread = useCallback(
    (threadId: string) => {
      setActiveThread(threadId)
    },
    [setActiveThread]
  )

  const handleDeleteThread = useCallback(
    async (threadId: string) => {
      await deleteThreadMutation.mutateAsync(threadId)
      // P1-5: 删除当前活跃会话后自动切换到下一个可见的 recent 会话
      // 若无剩余会话则回到欢迎页（activeThreadId = null）
      if (activeThreadId === threadId) {
        const remainingThreads = threads.filter(
          t => !t.archived && t.id !== threadId
        )
        setActiveThread(remainingThreads[0]?.id ?? null)
      }
    },
    [deleteThreadMutation, activeThreadId, threads, setActiveThread]
  )

  const handleArchiveThread = useCallback(
    async (threadId: string) => {
      await archiveThreadMutation.mutateAsync({
        threadId,
        archived: true,
      })
      // P1-5: 归档当前活跃会话后自动切换到下一个可见的 recent 会话
      // 若无剩余会话则回到欢迎页（activeThreadId = null）
      if (activeThreadId === threadId) {
        const remainingThreads = threads.filter(
          t => !t.archived && t.id !== threadId
        )
        setActiveThread(remainingThreads[0]?.id ?? null)
      }
    },
    [archiveThreadMutation, activeThreadId, threads, setActiveThread]
  )

  const handleRestoreThread = useCallback(
    async (threadId: string) => {
      await archiveThreadMutation.mutateAsync({
        threadId,
        archived: false,
      })
    },
    [archiveThreadMutation]
  )

  const handleRenameThread = useCallback(
    async (threadId: string, name: string) => {
      await renameThreadMutation.mutateAsync({ threadId, name })
    },
    [renameThreadMutation]
  )

  // 重命名结束回调 —— 清除 renamingThreadId。
  // 提取为稳定的 useCallback 引用，避免内联箭头破坏 ThreadItem 的 memo
  const handleRenameEnd = useCallback(() => {
    setRenamingThreadId(null)
  }, [])

  const handleDuplicateThread = useCallback(
    async (threadId: string) => {
      await forkThreadMutation.mutateAsync(threadId)
    },
    [forkThreadMutation]
  )

  const handlePinThread = useCallback(
    (threadId: string) => {
      // H1: 切换置顶状态 —— 已置顶则取消，未置顶则添加。
      // 通过 useSetThreadPinned mutation 乐观更新 thread.metadata.pinned，
      // pinnedIds 从 threads 缓存派生，自动跟随变化。
      // toast 副作用在 mutation 外部调用，避免 StrictMode 重复通知。
      const isPinned = pinnedIds.has(threadId)
      void setThreadPinnedMutation.mutateAsync({
        threadId,
        pinned: !isPinned,
      })
      toast.success(isPinned ? '已取消置顶' : '已置顶')
    },
    [pinnedIds, setThreadPinnedMutation]
  )

  // 清空归档：逐个删除已归档会话（mutation 内部处理乐观更新与错误回滚）
  const handleClearArchived = useCallback(async () => {
    const archivedThreads = threads.filter(t => t.archived)
    if (archivedThreads.length === 0) {
      toast.info('归档列表为空')
      return
    }
    // I-S-002: 破坏性操作保护 — 清空归档不可撤销，需用户二次确认
    // 使用命令式 confirm（对齐原型 showConfirmDialog），替代 window.confirm
    const confirmed = await confirm({
      title: '清空归档',
      message: '确定要清空所有已归档的会话吗？此操作不可撤销。',
      confirmText: '确认清空',
      danger: true,
    })
    if (!confirmed) {
      return
    }
    try {
      // P1 修复：使用 allSettled 替代 all —— 某个删除失败不应中断其余删除，
      // 也不应让已成功的删除回滚。按成功/失败计数分别提示用户。
      const results = await Promise.allSettled(
        archivedThreads.map(t => deleteThreadMutation.mutateAsync(t.id))
      )
      const succeeded = results.filter(r => r.status === 'fulfilled').length
      const failed = results.length - succeeded
      if (failed === 0) {
        toast.success(`已清空 ${succeeded} 个归档会话`)
      } else {
        toast.error(`${succeeded} 个成功，${failed} 个删除失败`)
      }
    } catch (err) {
      // allSettled 本身不会 reject，此分支仅兜底未预期异常
      toast.error('清空归档会话失败')
      console.error('Failed to clear archived threads:', err)
    }
  }, [threads, deleteThreadMutation])

  const handleShowFiles = useCallback(
    (_threadId: string) => {
      // 切换到文件树视图；FileTree 组件内部提供返回按钮
      setSidebarView('fileTree')
    },
    [setSidebarView]
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, threadId: string) => {
      e.preventDefault()
      setCtxMenu({ position: { x: e.clientX, y: e.clientY }, threadId })
    },
    []
  )

  const ctxThread = ctxMenu
    ? threads.find(t => t.id === ctxMenu.threadId)
    : null

  const isEmpty = filteredThreads.length === 0
  const emptyText = searchQuery
    ? `未找到匹配"${searchQuery}"的会话`
    : activeTab === 'archived'
      ? '暂无归档会话'
      : '暂无会话，点击上方"新建会话"开始'

  return (
    <aside
      // h-full: 填满父容器（motion.div className="h-full"），使 aside 高度固定而非随内容增长
      // min-h-0: 允许 flex item 在内容溢出时缩小到小于内容高度，触发内部滚动条
      // 两者结合：aside 占满父容器高度，内部列表区(flex-1 + min-h-0)在内容增长时滚动而非撑高 aside
      className="relative flex h-full min-h-0 min-w-0 flex-col border-r border-[var(--border)] bg-[var(--bg-elev)]"
      aria-label="会话侧栏"
    >
      {sidebarView === 'fileTree' ? (
        <FileTree />
      ) : (
        <>
          {/* 头部：新建会话 + 搜索 + 标签页 */}
          <div className="border-b border-[var(--border)] p-3">
            <button
              type="button"
              onClick={handleCreateThread}
              disabled={createThreadMutation.isPending}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--accent)] px-[9px] py-[9px] text-[12.5px] font-semibold text-[#001814] shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-[box-shadow,transform] duration-200 hover:translate-y-[-1px] hover:shadow-[0_0_20px_var(--accent-glow),inset_0_1px_0_rgba(255,255,255,0.3)] active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Plus width={13} height={13} strokeWidth={2.5} />
              新建会话
            </button>

            <div className="relative px-2.5 pb-1 pt-2">
              <Search
                width={13}
                height={13}
                className="pointer-events-none absolute left-[18px] top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
              />
              <input
                type="text"
                name="sidebarSearch"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="搜索会话…"
                aria-label="搜索会话"
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-elev-2)] py-1.5 pl-7 pr-2.5 font-sans text-[12px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-faint)] focus:border-[var(--accent-dim)]"
              />
            </div>

            <div className="flex gap-0.5 border-b border-[var(--border)] px-2 pb-1.5" role="tablist">
              <SidebarTabButton
                tab="recent"
                activeTab={activeTab}
                count={counts.recent}
                onClick={() => setActiveTab('recent')}
              />
              <SidebarTabButton
                tab="archived"
                activeTab={activeTab}
                count={counts.archived}
                onClick={() => setActiveTab('archived')}
              />
            </div>
          </div>

          {/* List — min-h-0 确保 flex item 可缩小到小于内容高度，触发滚动条而非撑高父容器 */}
          {/* 不加 min-h-0 时，flex item 的 min-height 默认为 auto，会随内容增长把账户菜单顶上 */}
          <div
            className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-2"
            onContextMenu={e => {
              const target = (e.target as HTMLElement).closest('[data-id]')
              if (target) {
                const threadId = target.getAttribute('data-id')
                if (threadId) handleContextMenu(e, threadId)
              }
            }}
          >
            {activeTab === 'archived' && (
              // I-S-004: 归档分组标题栏 —— 保留是因为含"清空"操作按钮（有实际功能）
              // 最近 tab 不需要标题栏：顶部 tab 已标明"最近"，标题栏仅提供折叠属冗余
              <div className="flex items-center justify-between px-2.5 pb-[5px] pt-3.5 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-[var(--text-faint)]">
                <button
                  type="button"
                  onClick={() => setArchivedCollapsed(v => !v)}
                  className="flex items-center gap-1 transition-colors hover:text-[var(--text-dim)]"
                  aria-label={archivedCollapsed ? '展开已归档' : '收起已归档'}
                  title={archivedCollapsed ? '展开已归档' : '收起已归档'}
                  aria-expanded={!archivedCollapsed}
                >
                  {archivedCollapsed ? (
                    <ChevronRight width={10} height={10} strokeWidth={2.5} />
                  ) : (
                    <ChevronDown width={10} height={10} strokeWidth={2.5} />
                  )}
                  <span>已归档</span>
                </button>
                {/* 清空归档按钮：仅在非空且未收起时显示 */}
                {counts.archived > 0 && !archivedCollapsed && (
                  <button
                    type="button"
                    onClick={handleClearArchived}
                    // P0 修复：字号 9.5px → 10px、font-medium → font-mono（对齐原型 .group-action { font-family:var(--mono); font-size:10px }）
                    //   保留 hover:text-[var(--error)] 危险操作视觉强化（产品增强）
                    className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold normal-case tracking-normal text-[var(--text-faint)] transition-colors duration-[120ms] hover:bg-[var(--bg-elev-2)] hover:text-[var(--error)]"
                    title="清空所有归档会话"
                    aria-label="清空归档"
                  >
                    <Trash2 width={11} height={11} strokeWidth={2} />
                    清空
                  </button>
                )}
              </div>
            )}

            {/* 加载中提示 */}
            {isLoading && (
              <div className="px-4 py-8 text-center text-[12px] text-[var(--text-faint)]">
                加载中…
              </div>
            )}

            {/* Folder groups + 无文件夹会话 —— recent tab 始终显示，archived 受折叠状态控制 */}
            {(activeTab === 'recent' ||
              (activeTab === 'archived' && !archivedCollapsed)) && (
              <>
                {/* 置顶会话分组 —— 仅 recent tab 显示，固定在列表顶部 */}
                {pinnedThreads.length > 0 && (
                  <div className="mb-1">
                    {/* 置顶分组标题 */}
                    <div className="flex items-center gap-[5px] px-2.5 pt-[5px] pb-[3px] text-[11.5px] font-semibold text-[var(--text-dim)]">
                      <Pin className="h-[14px] w-[14px] text-[var(--text-faint)]" />
                      <span>置顶</span>
                    </div>
                    {/* 置顶会话列表 */}
                    {pinnedThreads.map(thread => (
                      <ThreadItem
                        key={thread.id}
                        thread={thread}
                        active={thread.id === activeThreadId}
                        highlighted={highlightedThreadIds.has(thread.id)}
                        renaming={thread.id === renamingThreadId}
                        onRenameEnd={handleRenameEnd}
                        onSelect={handleSelectThread}
                        onRename={handleRenameThread}
                        onDelete={handleDeleteThread}
                        onArchive={handleArchiveThread}
                        onRestore={handleRestoreThread}
                        onShowFiles={handleShowFiles}
                      />
                    ))}
                  </div>
                )}

                {/* 文件夹分组 */}
                {folders.map(folder => {
                  const items = threadsByFolder.get(folder) ?? []
                  if (items.length === 0) return null
                  const isCollapsed = collapsedFolders.has(folder)
                  return (
                    <div key={folder}>
                      {/* P1 修复：HTML 规范禁止 <button> 嵌套 <button>，外层改为 div + role="button" */}
                      {/*   保持 cursor-pointer / select-none / touch-manipulation / 键盘可访问性 */}
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => toggleFolder(folder)}
                        onKeyDown={e => {
                          // 键盘可访问性：Enter / Space 触发折叠切换（对齐原生 button 行为）
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            toggleFolder(folder)
                          }
                        }}
                        className={cn(
                          // P0 修复：补 cursor-pointer/select-none/touch-manipulation/text-left/duration-[120ms]
                          //   对齐原型 .folder-label { cursor:pointer; user-select:none; touch-action:manipulation; text-align:left; transition:color 0.12s }
                          'group/folder flex w-full cursor-pointer select-none touch-manipulation items-center gap-[5px] mt-0.5 rounded pl-1.5 pr-2.5 pt-[5px] pb-[3px] text-left text-[11.5px] font-semibold text-[var(--text-dim)] transition-colors duration-[120ms] hover:text-[var(--text)]',
                          isCollapsed && '[&_.fl-chevron]:-rotate-90'
                        )}
                        aria-label={`文件夹: ${folder}`}
                      >
                        {/* fl-chevron 包装容器 — 对齐原型 14×14 flex 居中容器，统一图标占位尺寸 */}
                        <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center text-[var(--text-faint)]">
                          <ChevronDown
                            width={10}
                            height={10}
                            strokeWidth={2.5}
                            className="fl-chevron transition-transform duration-150"
                          />
                        </span>
                        {/* fl-icon 包装容器 — 对齐原型 14×14 flex 居中容器 */}
                        <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center text-[var(--text-faint)]">
                          <FolderIcon
                            width={13}
                            height={13}
                            strokeWidth={2}
                          />
                        </span>
                        <span className="flex-1 truncate text-left">{folder}</span>
                        {/* 加号按钮 — 对齐原型 .fl-add-btn：18×18，默认 opacity:0，
                            hover 文件夹行时显示。数量信息保留在 title 中作为次要信息。
                            I-S-005: 使用原生 <button> 替代 span+role，键盘可访问性由浏览器原生保证。
                            e.stopPropagation() 阻止冒泡至外层文件夹折叠按钮。 */}
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation()
                            void handleCreateThreadInFolder(folder)
                          }}
                          // P0 修复：补 cursor-pointer + transition 属性范围（opacity,color,background-color）
                          //   对齐原型 .fl-add-btn { cursor:pointer; transition:opacity 0.15s,color 0.15s,background 0.15s }
                          className="flex h-[18px] w-[18px] shrink-0 cursor-pointer items-center justify-center rounded text-[var(--text-faint)] opacity-0 transition-[opacity,color,background-color] duration-150 hover:bg-[var(--bg-elev-2)] hover:text-[var(--accent)] group-hover/folder:opacity-100"
                          title={`在此文件夹新建会话（共 ${items.length} 个）`}
                          aria-label={`在 ${folder} 新建会话`}
                        >
                          <Plus width={12} height={12} strokeWidth={2.5} />
                        </button>
                      </div>

                      {!isCollapsed && (
                        // P0 修复：删除外层 ml-4（16px margin-left）
                        //   原型用 .thread-item[data-folder] { padding-left:26px } 自身偏移
                        //   前端已在 ThreadItem.tsx 内通过 thread.metadata.folder && 'pl-[26px]' 实现
                        //   此处保留 mb-0.5 用于项间距
                        <div className="mb-0.5">
                          {items.map(thread => (
                            <ThreadItem
                              key={thread.id}
                              thread={thread}
                              active={thread.id === activeThreadId}
                              highlighted={highlightedThreadIds.has(thread.id)}
                              renaming={thread.id === renamingThreadId}
                              onRenameEnd={handleRenameEnd}
                              onSelect={handleSelectThread}
                              onRename={handleRenameThread}
                              onDelete={handleDeleteThread}
                              onArchive={handleArchiveThread}
                              onRestore={handleRestoreThread}
                              onShowFiles={handleShowFiles}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}

                {/* 无文件夹的会话 */}
                {threadsWithoutFolder.map(thread => (
                  <ThreadItem
                    key={thread.id}
                    thread={thread}
                    active={thread.id === activeThreadId}
                    highlighted={highlightedThreadIds.has(thread.id)}
                    renaming={thread.id === renamingThreadId}
                    onRenameEnd={handleRenameEnd}
                    onSelect={handleSelectThread}
                    onRename={handleRenameThread}
                    onDelete={handleDeleteThread}
                    onArchive={handleArchiveThread}
                    onRestore={handleRestoreThread}
                    onShowFiles={handleShowFiles}
                  />
                ))}
              </>
            )}

            {/* 空状态 */}
            {isEmpty && !isLoading && (
              <div className="px-4 py-8 text-center text-[12px] leading-[1.6] text-[var(--text-faint)]">
                {emptyText}
              </div>
            )}
          </div>

          {/* Foot: account trigger + dropdown */}
          <div
            ref={accountRef}
            className="relative flex items-center gap-2 border-t border-[var(--border)] p-2.5"
          >
            <button
              type="button"
              onClick={() => setDropdownOpen(v => !v)}
              // T-B-001: 对齐原型 .account-trigger 圆角 6px（rounded-md）
              className="flex flex-1 min-w-0 items-center gap-2 rounded-md px-1 py-[3px] transition-colors hover:bg-[var(--bg-elev-2)]"
              aria-label="账户菜单"
              aria-expanded={dropdownOpen}
            >
              <div className="flex h-[26px] w-[26px] items-center justify-center rounded-md bg-gradient-to-br from-[#2A3441] to-[#1A2330] font-mono text-[11px] font-semibold text-[var(--accent)] border border-[var(--border-strong)]">
                DS
              </div>
              <div className="min-w-0 flex-1 text-left">
                <div className="text-[12px] text-[var(--text)]">dev</div>
                <div className="truncate font-mono text-[10.5px] text-[var(--text-faint)]">
                  api-key · sk-…
                </div>
              </div>
            </button>

            {/* 账户下拉菜单 — 对齐原型 .sidebar-dropdown 过渡动画：
                始终渲染，用 opacity + transform + pointer-events + visibility 控制显隐，
                避免 display:none 切换无法触发 transition。
                visibility:hidden 防止菜单"关闭"时 Tab 焦点落入不可见按钮（幽灵 Tab）。 */}
            <div
              aria-hidden={!dropdownOpen}
              className={cn(
                'absolute bottom-[calc(100%+6px)] left-2.5 right-2.5 z-[var(--z-fixed)] rounded-[9px] border border-[var(--border-strong)] bg-[var(--bg-elev)] p-1 shadow-[var(--shadow-elev)] transition-[opacity,transform] duration-150 ease-out',
                dropdownOpen
                  ? 'visible pointer-events-auto translate-y-0 opacity-100'
                  : 'invisible pointer-events-none translate-y-[6px] opacity-0'
              )}
            >
                <DropdownItem
                  icon={<User width={14} height={14} />}
                  label="账户信息"
                  onClick={() => {
                    setDropdownOpen(false)
                    onOpenAccount?.()
                  }}
                />
                <DropdownItem
                  icon={<Settings width={14} height={14} />}
                  label="设置"
                  onClick={() => {
                    setDropdownOpen(false)
                    onOpenSettings?.()
                  }}
                />
                <DropdownItem
                  icon={<MessageSquare width={14} height={14} />}
                  label="反馈"
                  onClick={() => {
                    setDropdownOpen(false)
                    onOpenFeedback?.()
                  }}
                />
                <DropdownItem
                  icon={<Info width={14} height={14} />}
                  label="关于"
                  onClick={() => {
                    setDropdownOpen(false)
                    onOpenAbout?.()
                  }}
                />
                <div className="my-1 mx-1.5 h-px bg-[var(--border)]" />
                <DropdownItem
                  icon={<LogOut width={14} height={14} />}
                  label="退出登录"
                  danger
                  onClick={() => {
                    setDropdownOpen(false)
                    onLogout?.()
                  }}
                />
            </div>
          </div>

          {/* 右键菜单 */}
          {ctxMenu && ctxThread && (
            <ThreadContextMenu
              position={ctxMenu.position}
              isArchived={ctxThread.archived}
              isDeleted={false}
              isPinned={pinnedIds.has(ctxThread.id)}
              onRename={() => {
                // 触发 ThreadItem 内联重命名模式（对齐原型 L12069-12100 的 input 编辑行为）
                setRenamingThreadId(ctxThread.id)
              }}
              onPin={() => handlePinThread(ctxThread.id)}
              onArchive={() => handleArchiveThread(ctxThread.id)}
              onDuplicate={() => handleDuplicateThread(ctxThread.id)}
              onDelete={() => handleDeleteThread(ctxThread.id)}
              onClose={() => setCtxMenu(null)}
            />
          )}
        </>
      )}
    </aside>
  )
}

interface SidebarTabButtonProps {
  /** 当前按钮对应的 tab 标识 */
  tab: SidebarTab
  /** 当前激活的 tab（用于高亮判定） */
  activeTab: SidebarTab
  /** 该 tab 下的会话数量，展示为圆形徽章 */
  count: number
  /** 点击回调 */
  onClick: () => void
}

/**
 * SidebarTabButton —— 侧栏顶部「最近 / 归档」标签切换按钮。
 *
 * 仅在 Sidebar 内部使用，不对外导出。
 *
 * @param props —— 见 SidebarTabButtonProps 接口
 */
function SidebarTabButton({
  tab,
  activeTab,
  count,
  onClick,
}: SidebarTabButtonProps) {
  const isActive = tab === activeTab
  const label = tab === 'recent' ? '最近' : '归档'
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={onClick}
      className={cn(
        // P0 修复：补 cursor-pointer + transition 属性范围 + 时长 120ms
        //   对齐原型 .sidebar-tab { cursor:pointer; transition:background-color,border-color,color,box-shadow 0.12s }
        'flex flex-1 cursor-pointer items-center justify-center gap-[5px] rounded-[5px] border-none px-2 py-[5px] font-sans text-[11px] font-medium transition-[background-color,border-color,color,box-shadow] duration-[120ms]',
        isActive
          ? 'bg-[var(--bg-elev-2)] text-[var(--accent)]'
          : 'text-[var(--text-faint)] hover:bg-[var(--bg-elev-2)] hover:text-[var(--text-dim)]'
      )}
    >
      {label}
      <span
        className={cn(
          'rounded-lg bg-[var(--bg)] px-[5px] py-px font-mono text-[9.5px] tabular-nums',
          isActive ? 'text-[var(--accent)]' : 'text-[var(--text-faint)]'
        )}
      >
        {count}
      </span>
    </button>
  )
}

interface DropdownItemProps {
  /** 行首图标（lucide-react 节点） */
  icon: React.ReactNode
  /** 行显示文字 */
  label: string
  /** 是否为危险操作（红色文字 + 红色 hover 背景） */
  danger?: boolean
  /** 点击回调 */
  onClick: () => void
}

/**
 * DropdownItem —— 账户下拉菜单的单项。
 *
 * 仅在 Sidebar 内部使用，不对外导出。
 *
 * @param props —— 见 DropdownItemProps 接口
 */
function DropdownItem({ icon, label, danger, onClick }: DropdownItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // T-B-002: 对齐原型 .sd-item 圆角 6px（rounded-md）
        'flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-[13px] transition-colors',
        danger
          ? 'text-[var(--error)] hover:bg-[rgba(255,107,107,0.1)]'
          : 'text-[var(--text)] hover:bg-[var(--bg-elev-2)]'
      )}
    >
      {icon}
      {label}
    </button>
  )
}
