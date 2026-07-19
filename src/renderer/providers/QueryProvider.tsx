// src/renderer/providers/QueryProvider.tsx
// TanStack Query 5 客户端 Provider
// 设计文档 §4.11 Mutation 失效策略 / §5.1 数据流

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { useState } from 'react';

/**
 * TanStack Query 默认配置
 *
 * - staleTime 60s：1 分钟内不重复请求（IPC 调用有成本）
 * - gcTime 5min：缓存 5 分钟后回收
 * - retry 1：IPC 失败一般不可重试，1 次抵御偶发抖动
 * - refetchOnWindowFocus false：Electron 单窗口，focus 事件频繁
 * - mutations.retry 0：变更不自动重试（用户手动重试）
 */
export function QueryProvider({ children }: { children: ReactNode }): ReactElement {
  // useState 懒初始化 QueryClient，避免每次 render 重建
  // React Compiler 会自动 memoize，但显式 useState 更明确
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            gcTime: 5 * 60_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
          mutations: { retry: 0 },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
