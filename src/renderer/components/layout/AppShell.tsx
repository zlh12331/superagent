// src/renderer/components/layout/AppShell.tsx
// 应用主布局容器 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 职责：
// - 两段式布局：Topbar（44px）/ 内容区
// - 不再依赖 useAppStatusStore（已随数据库层删除）
//
// 文学风设计：
// - 整体米黄纸张底色
// - Topbar 暖米色（次要层级）
// - 内容区主色（最浅，最聚焦）
// ──────────────────────────────────────────────────────────────
//
// 说明：原 Sidebar（业务导航）和 StatusBar（PG/Ollama 状态显示）
// 已随数据库层一并删除。当前仅保留 Topbar + 主内容区，作为模版骨架。

import type { ReactElement, ReactNode } from 'react';

import { Topbar } from './Topbar';

interface AppShellProps {
  /** 主内容区（通常由 RouterProvider 通过 <Outlet /> 传入） */
  children: ReactNode;
}

/**
 * 应用主布局
 *
 * 使用 CSS Grid 划分两行：Topbar / 内容区。
 * 不再订阅任何 IPC 事件，不持有状态，纯布局组件。
 */
export function AppShell({ children }: AppShellProps): ReactElement {
  return (
    <div className="bg-background text-foreground flex h-screen w-screen flex-col overflow-hidden font-sans">
      <Topbar />
      <main className="paper-texture min-h-0 flex-1 overflow-auto bg-background">{children}</main>
    </div>
  );
}
