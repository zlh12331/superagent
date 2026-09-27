// src/renderer/providers/QueryProvider.tsx
// TanStack Query Provider（L3 服务端请求状态层入口）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 向组件树注入 QueryClient（让 useQuery / useMutation 可用）
// - dev 模式动态挂载 Query Devtools 调试面板（生产 / dev:web / vitest 均不加载）
// - 配合 L2 Zustand 层（settings/sessions）+ L4 IPC 流式层
//
// 嵌套顺序（外 → 内）：
//   ThemeProvider → QueryProvider → TooltipProvider → Toaster → children
// ThemeProvider 在外层：theme 状态需要先于 query 失败提示生效
// ──────────────────────────────────────────────────────────────
//
// ⚠️ 本文件在生产模块图内（sourcemap sourcesContent 保留源码原文），
// 严禁出现 devtools 包名字符串或其组件标识符字面量——否则生产产物的
// 「devtools 零残留」rg 门禁（正则含包名与组件名两个交替分支）必挂。
// 相关字符串只允许存在于 ./query-devtools（该模块仅 DEV 可达，生产整体 DCE）。

import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { queryClient } from '@/lib/query/query-client';

/** Devtools 面板模块类型（仅 dev 经动态 import 可达；生产构建整体 DCE 不可达） */
type DevtoolsModule = typeof import('./query-devtools');

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
  // dev 专属调试面板模块（见 ./query-devtools 模块头注释的 DCE 说明）
  const [devtoolsModule, setDevtoolsModule] = useState<DevtoolsModule | null>(null);

  useEffect(() => {
    // 守卫三条件均为构建期常量，生产构建可整体 DCE：
    // - Electron dev（electron-vite dev，默认 development 模式）→ 挂载
    // - dev:web 与浏览器 E2E（--mode web）→ 不挂载：视觉回归跑在浏览器 E2E，
    //   浮动按钮不能污染视觉快照
    // - vitest → 不挂载：单测 DOM 保持纯净（Vitest 5 下取值为字符串 'true'，
    //   取反判真即生效；经索引签名访问，TS4111 要求方括号写法）
    if (import.meta.env.DEV && import.meta.env.MODE !== 'web' && !import.meta.env['VITEST']) {
      void import('./query-devtools').then(setDevtoolsModule);
    }
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {devtoolsModule ? <devtoolsModule.QueryDevtools /> : null}
    </QueryClientProvider>
  );
}
