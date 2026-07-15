/**
 * Thread 域 TanStack Query 钩子
 *
 * 状态管理决策树位置：
 *   数据在应用会话之间持久化吗？是 → TanStack Query
 *   线程列表是典型的服务端持久化数据，应使用 TanStack Query 管理，
 *   以获得自动缓存、失效、重试、stale-while-revalidate 等能力。
 *
 * 本文件提供线程列表的查询与突变钩子，替代旧版 Zustand 手工缓存。
 * UI 状态（activeTab、searchQuery、collapsedFolders）仍保留在 Zustand。
 *
 * @see src/lib/codex/thread.ts — API 层
 * @see src/store/thread-store.ts — 仅保留 UI 状态的精简 store
 */

import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import {
  listThreads,
  createThread,
  deleteThread,
  archiveThread,
  renameThread,
  forkThread,
  setThreadPinned,
} from '@/lib/codex/thread'
import type { Thread, ThreadId, ThreadMetadata } from '@/lib/codex/types'

// ─── Query Keys ────────────────────────────────────────────────────────────

/**
 * 线程域的 Query Key 工厂
 *
 * 采用层级结构，便于按范围失效缓存：
 * - threads.all — 失效所有线程相关查询
 * - threads.list() — 失效线程列表
 * - threads.detail(id) — 失效单个线程详情
 */
export const threadsQueryKeys = {
  all: ['threads'] as const,
  list: () => [...threadsQueryKeys.all, 'list'] as const,
  detail: (threadId: ThreadId) =>
    [...threadsQueryKeys.all, 'detail', threadId] as const,
}

// ─── 查询钩子 ───────────────────────────────────────────────────────────────

/**
 * 获取线程列表
 *
 * 替代旧版 Sidebar.tsx 中的 `useEffect + setLoading + listThreads().then()`
 * 手工加载逻辑。TanStack Query 自动管理 loading、缓存、重试、stale-while-revalidate。
 *
 * 缓存策略：
 *  - staleTime: 5 分钟（线程列表变更不频繁，5 分钟内复用缓存即可）
 *  - gcTime: 10 分钟（卸载组件后 10 分钟才回收，避免频繁切换面板时反复请求）
 *  - 后端返回全部线程（含归档），由 UI 层按 activeTab 过滤显示
 *
 * @returns UseQueryResult<Thread[]> — 包含 data/isLoading/error 等状态
 *
 * @see src/features/sidebar/Sidebar.tsx — 侧边栏组件，订阅此查询
 * @see src/store/thread-store.ts — UI 状态（activeTab/searchQuery）存放处
 */
export function useThreads(): UseQueryResult<Thread[]> {
  return useQuery({
    queryKey: threadsQueryKeys.list(),
    queryFn: async (): Promise<Thread[]> => {
      logger.debug('Loading threads from backend')
      // 不传 archived 参数，获取全部线程（含归档），
      // 由 UI 层按 activeTab 过滤显示
      return await listThreads()
    },
    staleTime: 1000 * 60 * 5, // 5 分钟内不重新请求
    gcTime: 1000 * 60 * 10, // 10 分钟后回收未使用的缓存
  })
}

// ─── 突变钩子 ───────────────────────────────────────────────────────────────

/**
 * 创建新线程
 *
 * 成功后失效线程列表查询，使 Sidebar 自动刷新。
 * 替代旧版 `addThread(thread) + setActiveThread(thread.id)` 的手工状态更新。
 *
 * @returns useMutation 结果，mutateAsync 接收 { cwd?, metadata? } 参数
 */
export function useCreateThread() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (params: {
      cwd: string | null
      metadata?: Partial<ThreadMetadata>
    }) => {
      logger.debug('Creating thread', { params })
      return await createThread(params.cwd, params.metadata)
    },
    onSuccess: thread => {
      // 失效列表查询，触发重新加载
      void queryClient.invalidateQueries({
        queryKey: threadsQueryKeys.list(),
      })
      logger.info('Thread created', { threadId: thread.id })
      toast.success('已创建新会话')
    },
    onError: error => {
      logger.error('Failed to create thread', { error })
      toast.error('创建会话失败')
    },
  })
}

/**
 * 删除线程
 *
 * 乐观更新：先从缓存中移除，失败后回滚。
 * 替代旧版 `removeThread(threadId) + deleteThread(threadId)` 的手工流程。
 *
 * @returns useMutation 结果，mutateAsync 接收 threadId
 */
export function useDeleteThread() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (threadId: ThreadId) => {
      logger.debug('Deleting thread', { threadId })
      await deleteThread(threadId)
      return threadId
    },
    // 乐观更新：突变前从缓存中移除
    onMutate: async threadId => {
      // 取消正在进行的列表查询，避免覆盖乐观更新
      await queryClient.cancelQueries({
        queryKey: threadsQueryKeys.list(),
      })
      const previousThreads = queryClient.getQueryData<Thread[]>(
        threadsQueryKeys.list()
      )
      // 从缓存中移除被删除的线程
      queryClient.setQueryData<Thread[]>(
        threadsQueryKeys.list(),
        old => old?.filter(t => t.id !== threadId) ?? []
      )
      return { previousThreads }
    },
    // 失败时回滚
    onError: (error, threadId, context) => {
      logger.error('Failed to delete thread', { threadId, error })
      if (context?.previousThreads) {
        queryClient.setQueryData(
          threadsQueryKeys.list(),
          context.previousThreads
        )
      }
      toast.error('删除失败')
    },
    onSuccess: (threadId, _, context) => {
      logger.info('Thread deleted', { threadId })
      // 从乐观更新前的缓存中查找原标题，用于显示成功提示
      const thread = context?.previousThreads?.find(t => t.id === threadId)
      const truncatedTitle =
        thread && thread.title.length > 18
          ? `${thread.title.slice(0, 18)}…`
          : thread?.title ?? ''
      toast.success(`已删除: ${truncatedTitle}`)
    },
  })
}

/**
 * 归档/取消归档线程
 *
 * 乐观更新：先更新缓存中的 archived 字段，失败后回滚。
 * 替代旧版 `archiveInStore + archiveThread + 失败回滚 unarchiveThread` 的手工流程。
 *
 * @returns useMutation 结果，mutateAsync 接收 { threadId, archived }
 */
export function useArchiveThread() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (params: {
      threadId: ThreadId
      archived: boolean
    }) => {
      logger.debug('Archiving thread', params)
      await archiveThread(params.threadId, params.archived)
      return params
    },
    // 乐观更新：立即修改缓存中的 archived 字段
    onMutate: async params => {
      await queryClient.cancelQueries({
        queryKey: threadsQueryKeys.list(),
      })
      const previousThreads = queryClient.getQueryData<Thread[]>(
        threadsQueryKeys.list()
      )
      queryClient.setQueryData<Thread[]>(
        threadsQueryKeys.list(),
        old =>
          old?.map(t =>
            t.id === params.threadId
              ? {
                  ...t,
                  archived: params.archived,
                  archivedAt: params.archived ? Date.now() : null,
                }
              : t
          ) ?? []
      )
      return { previousThreads }
    },
    onError: (error, params, context) => {
      logger.error('Failed to archive thread', { params, error })
      if (context?.previousThreads) {
        queryClient.setQueryData(
          threadsQueryKeys.list(),
          context.previousThreads
        )
      }
      toast.error(params.archived ? '归档失败' : '恢复失败')
    },
    onSuccess: params => {
      logger.info('Thread archived', params)
      toast.success(
        params.archived ? '已归档会话' : '已恢复会话到「最近」'
      )
    },
  })
}

/**
 * 重命名线程
 *
 * 乐观更新：先更新缓存中的 title 字段，失败后回滚。
 * 替代旧版 `renameInStore + renameThread + 失败回滚 renameInStore(oldName)` 的手工流程。
 *
 * @returns useMutation 结果，mutateAsync 接收 { threadId, name }
 */
export function useRenameThread() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (params: { threadId: ThreadId; name: string }) => {
      logger.debug('Renaming thread', params)
      await renameThread(params.threadId, params.name)
      return params
    },
    // 乐观更新：立即修改缓存中的 title 字段
    onMutate: async params => {
      await queryClient.cancelQueries({
        queryKey: threadsQueryKeys.list(),
      })
      const previousThreads = queryClient.getQueryData<Thread[]>(
        threadsQueryKeys.list()
      )
      queryClient.setQueryData<Thread[]>(
        threadsQueryKeys.list(),
        old =>
          old?.map(t =>
            t.id === params.threadId ? { ...t, title: params.name } : t
          ) ?? []
      )
      return { previousThreads }
    },
    onError: (error, params, context) => {
      logger.error('Failed to rename thread', { params, error })
      if (context?.previousThreads) {
        queryClient.setQueryData(
          threadsQueryKeys.list(),
          context.previousThreads
        )
      }
      toast.error('重命名失败')
    },
    onSuccess: params => {
      logger.info('Thread renamed', params)
      const truncated =
        params.name.length > 20 ? `${params.name.slice(0, 20)}…` : params.name
      toast.success(`已重命名: ${truncated}`)
    },
  })
}

/**
 * 分叉（复制）线程
 *
 * 成功后失效线程列表查询，使 Sidebar 自动刷新。
 *
 * @returns useMutation 结果，mutateAsync 接收 threadId，返回新线程或 null
 */
export function useForkThread() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (threadId: ThreadId): Promise<Thread | null> => {
      logger.debug('Forking thread', { threadId })
      return await forkThread(threadId)
    },
    onSuccess: (forked, threadId) => {
      if (forked) {
        // 失效列表查询，触发重新加载
        void queryClient.invalidateQueries({
          queryKey: threadsQueryKeys.list(),
        })
        logger.info('Thread forked', {
          sourceThreadId: threadId,
          newThreadId: forked.id,
        })
        toast.success('已创建副本')
      }
    },
    onError: (error, threadId) => {
      logger.error('Failed to fork thread', { threadId, error })
      toast.error('创建副本失败')
    },
  })
}

/**
 * 设置线程置顶状态
 *
 * 对齐原型 L12101-12108: 通过 `thread/metadata/update` 持久化 pinned 字段。
 *
 * 乐观更新策略（与 useRenameThread 一致）：
 *   1. onMutate: 立即更新缓存中对应 thread 的 `metadata.pinned` 字段
 *   2. mutationFn: 调用 setThreadPinned（Tauri 模式 no-op，待 DTO 扩展）
 *   3. onError: 回滚缓存到之前的状态
 *
 * 说明：
 *   - pinnedIds 不再用 localStorage 持久化，改为从 threads 缓存派生
 *   - Tauri 模式下 DTO 暂不支持 pinned 字段，但乐观更新仍可反映 UI 变化
 *     （页面刷新后状态会丢失，待后端 DTO 扩展后持久化生效）
 *
 * @returns useMutation 结果，mutateAsync 接收 { threadId, pinned }
 */
export function useSetThreadPinned() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (params: { threadId: ThreadId; pinned: boolean }) => {
      logger.debug('Setting thread pinned', params)
      await setThreadPinned(params.threadId, params.pinned)
      return params
    },
    // 乐观更新：立即修改缓存中的 metadata.pinned 字段
    onMutate: async params => {
      await queryClient.cancelQueries({
        queryKey: threadsQueryKeys.list(),
      })
      const previousThreads = queryClient.getQueryData<Thread[]>(
        threadsQueryKeys.list()
      )
      queryClient.setQueryData<Thread[]>(
        threadsQueryKeys.list(),
        old =>
          old?.map(t =>
            t.id === params.threadId
              ? {
                  ...t,
                  metadata: { ...t.metadata, pinned: params.pinned },
                }
              : t
          ) ?? []
      )
      return { previousThreads }
    },
    onError: (error, params, context) => {
      logger.error('Failed to set thread pinned', { params, error })
      if (context?.previousThreads) {
        queryClient.setQueryData(
          threadsQueryKeys.list(),
          context.previousThreads
        )
      }
      toast.error('置顶操作失败')
    },
  })
}
