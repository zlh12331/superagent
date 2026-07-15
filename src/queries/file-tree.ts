/**
 * File Tree 域 TanStack Query 钩子
 *
 * 状态管理决策树位置：
 *   数据在应用会话之间持久化吗？是 → TanStack Query
 *   文件树是典型的服务端持久化数据，应使用 TanStack Query 管理。
 *
 * 本文件提供文件树的查询钩子和失效工具函数，
 * 替代旧版 file-tree-store.refresh 的手工异步逻辑和
 * FileTree.tsx 中的 useEffect + getFileTree + setLoading 土法 useQuery。
 *
 * 事件驱动更新：
 *   FileTree.tsx 监听 fs/watch 事件后调用 invalidateFileTree，
 *   TanStack Query 自动重新拉取最新文件树。
 *
 * @see src/lib/codex/fs.ts — API 层
 * @see src/features/file-tree/file-tree-store.ts — 仅保留 UI 状态的精简 store
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import { getFileTree } from '@/lib/codex/fs'
import type { FileTreeNode } from '@/features/file-tree/types'

// ─── Query Keys ────────────────────────────────────────────────────────────

/**
 * 文件树域的 Query Key 工厂
 *
 * 采用层级结构，便于按范围失效缓存：
 * - fileTree.all — 失效所有文件树相关查询
 * - fileTree.tree() — 失效文件树根查询
 */
export const fileTreeQueryKeys = {
  all: ['fileTree'] as const,
  tree: () => [...fileTreeQueryKeys.all, 'tree'] as const,
}

// ─── 查询钩子 ───────────────────────────────────────────────────────────────

/**
 * 获取文件树
 *
 * 替代旧版 FileTree.tsx 中的 `useEffect + setLoading + getFileTree().then()`
 * 手工加载逻辑。TanStack Query 自动管理 loading、缓存、重试、stale-while-revalidate。
 *
 * 错误处理统一为 toast 提示（参照 window-commands 模式），
 * 消除旧版三处异步逻辑两种错误处理策略的不一致。
 *
 * 缓存策略：
 *  - staleTime: 5 分钟（文件树变更不频繁，5 分钟内复用缓存即可）
 *  - gcTime: 10 分钟（卸载组件后 10 分钟才回收，避免频繁切换面板时反复请求）
 *
 * @returns UseQueryResult<FileTreeNode> — 包含 data/isLoading/error 等状态
 *
 * @see src/features/file-tree/FileTree.tsx — 文件树 UI 组件，订阅此查询
 * @see invalidateFileTree — 配套的缓存失效函数
 */
export function useFileTree(): UseQueryResult<FileTreeNode> {
  return useQuery({
    queryKey: fileTreeQueryKeys.tree(),
    queryFn: async (): Promise<FileTreeNode> => {
      logger.debug('Loading file tree from backend')
      return await getFileTree()
    },
    staleTime: 1000 * 60 * 5, // 5 分钟内不重新请求
    gcTime: 1000 * 60 * 10, // 10 分钟后回收未使用的缓存
    // 统一错误处理（替代旧版 console.error + 部分 toast 的不一致策略）
    meta: {
      onError: (error: unknown) => {
        logger.error('Failed to load file tree', { error })
        toast.error('加载文件树失败', {
          description:
            error instanceof Error ? error.message : '未知错误',
        })
      },
    },
  })
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────

/**
 * 失效文件树查询
 *
 * 供事件监听器调用：当收到 fs/watch 事件时，
 * 调用此函数触发 TanStack Query 重新拉取最新文件树。
 *
 * @param queryClient — TanStack Query 客户端实例
 */
export function invalidateFileTree(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({
    queryKey: fileTreeQueryKeys.tree(),
  })
}
