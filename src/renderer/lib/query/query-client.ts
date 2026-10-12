import { QueryClient } from '@tanstack/react-query';

/**
 * 全局 QueryClient 单例
 *
 * 必须在 QueryProvider 中通过 <QueryClientProvider client={queryClient}> 注入。
 *
 * @example
 * ```tsx
 * import { queryClient } from '@/lib/query/query-client';
 * import { unwrap } from '@/lib/ipc';
 *
 * // window.api 是 preload 生成的命名空间 API（如 window.api.file.list），
 * // 不存在 window.api.invoke（invoke 是 preload 内部实现，渲染层不可见）
 * // IPC 响应统一由 unwrap 解包：成功返回 data，失败抛 [CODE] message
 * const files = useQuery({
 *   queryKey: ['files', dirPath],
 *   queryFn: async () => unwrap(await window.api.file.list({ path: dirPath })),
 * });
 * ```
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
    mutations: {
      retry: 0,
    },
  },
});
