// src/renderer/providers/query-devtools.tsx
// TanStack Query Devtools 挂载点（仅开发模式可达）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 收敛 devtools 包的唯一 import 点，渲染浮动调试面板（默认收起）
//
// 为什么单独成模块（而不是直接写在 QueryProvider 里）：
// - QueryProvider 位于生产图（AppProviders 静态引用链），其 sourcemap
//   sourcesContent 会保留源码原文——若包名串 `@tanstack/react-query-devtools`
//   或组件名 ReactQueryDevtools 出现在该文件（哪怕在死分支/注释里），
//   `rg 'react-query-devtools|ReactQueryDevtools' out` 门禁必然命中
//   （先例：main.tsx 死分支的 installMockApi 引用串留在了产物 map 里）。
// - 本模块只被 QueryProvider 的 DEV 守卫动态 import：生产构建 DEV=false →
//   分支整体 DCE → 本模块不进模块图 → 连 sourcesContent 都整体缺席，
//   实证同 main.tsx 死分支的 mock-api.ts（buildMockTurns 在 out/ 零命中）。
// - ⚠️ 因此 QueryProvider.tsx 内严禁出现 'react-query-devtools' /
//   'ReactQueryDevtools' 字面串，改动时务必保持。
// ──────────────────────────────────────────────────────────────

import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import type { ReactElement } from 'react';

/**
 * dev 专属 Query Devtools 面板
 *
 * initialIsOpen=false：默认收起，仅显示浮动开关按钮，不遮挡业务界面。
 * 可视化 query 缓存与失效链路（use-agent-bridge 事件中枢触发的
 * invalidate 在这里一眼可见），弥补五处历史失效遗漏靠读代码发现的问题。
 */
export function QueryDevtools(): ReactElement {
  return <ReactQueryDevtools initialIsOpen={false} />;
}
