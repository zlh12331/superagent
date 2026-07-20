// src/renderer/components/layout/AppShell.tsx
// 应用主布局容器 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 职责：
// - 三段式布局：Topbar（44px）/ Sidebar + 内容 / StatusBar（28px）
// - mount 时启动 app-status store 订阅 PG/Ollama 状态
// - unmount 时 cleanup 解除订阅
//
// 文学风设计：
// - 整体米黄纸张底色
// - Topbar 与 Sidebar 共用暖米色（次要层级）
// - 内容区主色（最浅，最聚焦）
// - StatusBar 深墨色（次要信息层）
// ──────────────────────────────────────────────────────────────

import type { ReactElement, ReactNode } from 'react';
import { useEffect } from 'react';

import { useAppStatusStore } from '@/stores/app-status.store';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { Topbar } from './Topbar';

interface AppShellProps {
  /** 主内容区（通常由 RouterProvider 通过 <Outlet /> 传入） */
  children: ReactNode;
}

/**
 * 应用主布局
 *
 * 使用 CSS Grid 划分三行：Topbar / Sidebar+内容 / StatusBar。
 * Sidebar 折叠时宽度变化由 Sidebar 组件自身控制，AppShell 不参与宽度计算。
 *
 * useEffect 中调用 app-status store 的 init()：
 * - 启动 IPC 订阅（onPgStatusChange / onOllamaStatusChange / onOllamaPullProgress）
 * - 立即拉取一次最新状态
 * - 返回 cleanup 函数，组件卸载时解除订阅
 */
export function AppShell({ children }: AppShellProps): ReactElement {
  // 启动 PG/Ollama 状态订阅，仅执行一次
  useEffect(() => {
    const cleanup = useAppStatusStore.getState().init();
    return cleanup;
  }, []);

  return (
    <div className="bg-background text-foreground flex h-screen w-screen flex-col overflow-hidden font-sans">
      <Topbar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="paper-texture min-w-0 flex-1 overflow-auto bg-background">{children}</main>
      </div>
      <StatusBar />
    </div>
  );
}
