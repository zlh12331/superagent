// src/renderer/lib/query/query-client.ts
// TanStack Query 客户端配置（L3 服务端请求状态层）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 提供 QueryClient 单例 + 默认配置
// - 与 L4 流式推送层的差异：
//   - L3 适合 IPC invoke（请求-响应）：useQuery(['files'], () => api.invoke('files:get'))
//   - L4 适合 IPC on（持续推送）：Zustand 订阅事件
//
// 默认配置策略：
// - staleTime: 30s（30s 内同 key 不会触发重取，避免组件 remount 重复请求）
// - gcTime: 5min（5min 内的 cache 不会回收，便于组件快速切换）
// - refetchOnWindowFocus: false（Electron 无浏览器焦点切换，关掉避免无谓重取）
// - retry: 1（IPC 失败重试一次，避免主进程偶发卡顿误报）
// ──────────────────────────────────────────────────────────────

import { QueryClient } from '@tanstack/react-query';

/**
 * 全局 QueryClient 单例
 *
 * 必须在 QueryProvider 中通过 <QueryClientProvider client={queryClient}> 注入。
 *
 * @example
 * ```tsx
 * import { queryClient } from '@/lib/query/query-client';
 *
 * const files = useQuery({
 *   queryKey: ['files', projectId],
 *   queryFn: () => window.api.invoke('files:get', projectId),
 * });
 * ```
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 30s 内不触发重取（避免组件 remount 重复请求）
      staleTime: 30_000,
      // 5min 内的 cache 不会回收
      gcTime: 5 * 60 * 1000,
      // Electron 无浏览器焦点切换，关闭避免无谓重取
      refetchOnWindowFocus: false,
      // IPC 失败重试一次
      retry: 1,
      refetchOnReconnect: true,
    },
    mutations: {
      // mutation 不重试（避免重复写入）
      retry: 0,
    },
  },
});
