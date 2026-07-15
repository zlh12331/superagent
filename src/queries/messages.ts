/**
 * Message 域 TanStack Query 钩子
 *
 * 状态管理决策树位置：
 *   数据在应用会话之间持久化吗？是 → TanStack Query
 *   消息列表是典型的服务端持久化数据，应使用 TanStack Query 管理。
 *
 * 本文件提供消息列表的查询与轮次（Turn）相关突变钩子，
 * 替代旧版 conversation-store 中的 loadMessages / sendMessage / cancelActiveTurn。
 * 纯 UI 状态（sending、activeTurn）仍保留在 Zustand。
 *
 * 事件驱动更新：
 *   ConversationArea 监听 codex:notification 事件后调用 invalidateMessages，
 *   TanStack Query 自动重新拉取最新消息，无需手工 appendMessage。
 *
 * @see src/lib/codex/turn.ts — API 层
 * @see src/features/conversation/conversation-store.ts — 仅保留 UI 状态的精简 store
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
  listMessages,
  startTurn,
  cancelTurn,
} from '@/lib/codex/turn'
import type { Message, Turn, ThreadId, TurnId } from '@/lib/codex/types'
import type { QueryClient } from '@tanstack/react-query'

// ─── Query Keys ────────────────────────────────────────────────────────────

/**
 * 消息域的 Query Key 工厂
 *
 * 采用层级结构，便于按范围失效缓存：
 * - messages.all — 失效所有消息相关查询
 * - messages.byThread(threadId) — 失效指定线程的消息列表
 */
export const messagesQueryKeys = {
  all: ['messages'] as const,
  byThread: (threadId: ThreadId) =>
    [...messagesQueryKeys.all, 'thread', threadId] as const,
}

// ─── 查询钩子 ───────────────────────────────────────────────────────────────

/**
 * 获取指定线程的消息列表
 *
 * 替代旧版 conversation-store.loadMessages 的手工缓存管理。
 * TanStack Query 自动管理 loading、缓存、重试、stale-while-revalidate。
 *
 * 缓存策略：
 *  - staleTime: 30 秒（消息更新频率较高，相对短一些以保证及时性）
 *  - gcTime: 5 分钟（卸载组件后 5 分钟才回收，避免切换线程时反复请求）
 *  - queryKey 按 threadId 隔离缓存，切换线程时自动复用对应缓存
 *
 * @param threadId — 线程 ID（null 时不启用查询）
 * @param enabled — 是否启用查询（可选，用于条件查询）
 * @returns UseQueryResult<Message[]> — 包含 data/isLoading/error 等状态
 *
 * @see src/store/streaming-store.ts — 流式消息缓冲区，归档后写入此查询缓存
 * @see invalidateMessages — 配套的缓存失效函数
 */
export function useMessages(
  threadId: ThreadId | null,
  enabled = true
): UseQueryResult<Message[]> {
  return useQuery({
    queryKey: messagesQueryKeys.byThread(threadId ?? ''),
    queryFn: async (): Promise<Message[]> => {
      // threadId 为 null 时不会执行（enabled 控制），但类型上需要处理
      if (threadId === null) return []
      logger.debug('Loading messages from backend', { threadId })
      return await listMessages(threadId)
    },
    enabled: threadId !== null && enabled,
    // staleTime 从 30s 调整为 2 分钟：
    //   - 消息列表的即时性已由 ConversationArea 的事件订阅 + setQueryData 乐观更新保证，
    //     staleTime 仅用于控制「窗口聚焦/组件挂载」时的后台 refetch 触发频率；
    //   - 30s 过于激进，频繁切窗/切线程会引发不必要的 listMessages IPC 调用；
    //   - 2 分钟在保证 UI 一致性的同时大幅减少 IPC 次数。
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 5, // 5 分钟后回收未使用的缓存
  })
}

// ─── 突变钩子 ───────────────────────────────────────────────────────────────

/**
 * 启动新轮次（发送用户消息）
 *
 * 成功后失效该线程的消息列表查询，触发自动刷新。
 * 替代旧版 conversation-store.sendMessage 的手工乐观更新 + 错误兜底逻辑。
 *
 * 注意：旧版会在发送失败时追加一条伪 assistant 消息提示错误，
 * 新版改为通过 toast 统一报错，保持错误处理策略一致（参照 window-commands 模式）。
 *
 * @returns useMutation 结果，mutateAsync 接收 { threadId, message }
 */
export function useStartTurn() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (params: {
      threadId: ThreadId
      message: string
      model?: string | null
      cwd?: string | null
    }): Promise<Turn> => {
      logger.debug('Starting turn', { threadId: params.threadId })
      return await startTurn(
        params.threadId,
        params.message,
        params.model,
        params.cwd
      )
    },
    onSuccess: (turn, params) => {
      // 失效消息列表查询，触发重新拉取（后端会保存用户消息）
      void queryClient.invalidateQueries({
        queryKey: messagesQueryKeys.byThread(params.threadId),
      })
      logger.info('Turn started', {
        threadId: params.threadId,
        turnId: turn.id,
      })
    },
    onError: (error, params) => {
      logger.error('Failed to start turn', { threadId: params.threadId, error })
      toast.error('发送消息失败', {
        description:
          error instanceof Error ? error.message : '未知错误',
      })
    },
  })
}

/**
 * 中断正在进行的轮次
 *
 * 成功后失效该线程的消息列表查询，确保显示最终状态。
 * 替代旧版 conversation-store.cancelActiveTurn 的手工状态管理。
 *
 * @returns useMutation 结果，mutateAsync 接收 { threadId, turnId }
 */
export function useCancelTurn() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (params: {
      threadId: ThreadId
      turnId: TurnId
    }): Promise<void> => {
      logger.debug('Cancelling turn', params)
      await cancelTurn(params.threadId, params.turnId)
    },
    onSuccess: (_, params) => {
      // 失效消息列表查询，拉取最终状态
      void queryClient.invalidateQueries({
        queryKey: messagesQueryKeys.byThread(params.threadId),
      })
      logger.info('Turn cancelled', params)
      toast.success('已停止当前 Turn')
    },
    onError: (error, params) => {
      logger.error('Failed to cancel turn', { params, error })
      toast.error('停止 Turn 失败', {
        description:
          error instanceof Error ? error.message : '未知错误',
      })
    },
  })
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────

/**
 * 失效指定线程的消息列表查询
 *
 * 供事件监听器调用：当收到 codex:notification 事件时，
 * 调用此函数触发 TanStack Query 重新拉取最新消息。
 *
 * @param queryClient — TanStack Query 客户端实例
 * @param threadId — 要失效的线程 ID
 */
export function invalidateMessages(
  queryClient: QueryClient,
  threadId: ThreadId
): void {
  void queryClient.invalidateQueries({
    queryKey: messagesQueryKeys.byThread(threadId),
  })
}
