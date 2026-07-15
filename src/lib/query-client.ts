/**
 * @file 全局 TanStack Query 客户端单例。
 *
 * 职责：为整个应用提供共享的 QueryClient 实例，统一缓存策略与错误处理。
 *
 * 设计要点：
 *  - 桌面应用不同于网页，关闭再打开是常态，关闭 refetchOnWindowFocus
 *    避免每次切换窗口都重新请求造成网络抖动；
 *  - staleTime 5 分钟匹配 Tauri 后端 IPC 数据通常不需要高频更新；
 *  - gcTime 10 分钟内未使用的查询会被垃圾回收，平衡内存占用与缓存命中率；
 *  - queries 失败重试 1 次：避免对端偶发抖动放大成 UI 错误，同时不掩盖持续故障；
 *  - mutations 重试 0 次：绝大多数 mutation 是非幂等操作（创建/删除/归档/发送消息），
 *    重试会导致生产数据重复，必须由调用方在需要时单独配置 retry；
 *  - QueryCache / MutationCache 全局 onError 统一上报 Sentry + 记录日志，
 *    并读取 query.meta.onError 触发局部错误处理（如 file-tree 的 toast 提示）。
 *
 * 装配位置：main.tsx 通过 QueryClientProvider 注入到 React 树根。
 */

import {
  QueryClient,
  QueryCache,
  MutationCache,
} from '@tanstack/react-query'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/sentry'

/**
 * 全局 QueryClient 单例。
 *
 * 注意：不要在测试中直接使用此实例，应通过 test/test-utils.tsx 中的
 *   createTestQueryClient 构造独立实例，避免单例污染。
 */
export const queryClient = new QueryClient({
  // 全局查询缓存：所有 useQuery 失败时统一处理
  queryCache: new QueryCache({
    onError: (error, query) => {
      // 记录结构化日志，便于调试
      logger.error('Query failed', {
        queryKey: query.queryKey,
        error: error instanceof Error ? error.message : String(error),
      })
      // 上报到 Sentry（仅在用户授权后实际发送）
      captureException(error)
      // 读取 query.meta 上挂载的局部 onError 回调
      // （TanStack v5 移除了 useQuery 的 onError 选项，必须由全局 QueryCache 显式调用）
      const metaOnError = (
        query.meta as { onError?: (e: unknown) => void } | undefined
      )?.onError
      metaOnError?.(error)
    },
  }),
  // 全局突变缓存：所有 useMutation 失败时统一处理
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      logger.error('Mutation failed', {
        mutationKey: mutation.options.mutationKey,
        error: error instanceof Error ? error.message : String(error),
      })
      captureException(error)
    },
  }),
  defaultOptions: {
    queries: {
      // 桌面应用中不在窗口聚焦时重新拉取
      refetchOnWindowFocus: false,
      // 失败请求重试 1 次（查询是幂等的，重试安全）
      retry: 1,
      // 数据缓存 5 分钟
      staleTime: 1000 * 60 * 5,
      // 数据在缓存中保留 10 分钟
      gcTime: 1000 * 60 * 10,
    },
    mutations: {
      // 非幂等操作（创建/删除/归档/发送消息）重试会导致生产数据重复
      // 需要重试的幂等 mutation 由调用方单独配置 retry
      retry: 0,
    },
  },
})
