// src/renderer/providers/QueryProvider.tsx
// TanStack Query Provider（L3 服务端请求状态层入口）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 向组件树注入 QueryClient（让 useQuery / useMutation 可用）
// - 配合 L2 Zustand 层（settings/sessions）+ L4 IPC 流式层
//
// 嵌套顺序（外 → 内）：
//   ThemeProvider → QueryProvider → TooltipProvider → Toaster → children
// ThemeProvider 在外层：theme 状态需要先于 query 失败提示生效
// ──────────────────────────────────────────────────────────────

import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';

import { queryClient } from '@/lib/query/query-client';

/**
 * TanStack Query Provider
 *
 * 在 AppProviders 中包裹一次即可，业务组件直接用 useQuery / useMutation。
 *
 * @example
 * ```tsx
 * // 业务 hook 中
 * const { data: files } = useQuery({
 *   queryKey: ['files', projectId],
 *   queryFn: () => window.api.invoke('files:get', projectId),
 * });
 * ```
 */
export function QueryProvider({ children }: { children: ReactNode }): ReactElement {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
