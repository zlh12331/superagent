// src/renderer/components/layout/AppShell.tsx
// 应用主布局容器（Topbar + Sidebar + children + StatusBar）
// 设计文档 §3 目录结构 + §7.8/§7.9 状态监控
//
// 职责：
// - 三段式布局：顶部 Topbar（44px）/ 中部 Sidebar+内容 / 底部 StatusBar（28px）
// - 在 mount 时启动 app-status store 的 init() 订阅 PG/Ollama 状态
// - 在 unmount 时调用 cleanup 解除订阅，避免内存泄漏
//
// 注意：AppShell 不直接渲染业务内容，业务内容由调用方通过 children 传入
// （通常 RootLayout 传入 <Outlet /> 由 router 注入路由内容）。
// 这样路由切换时 Topbar/Sidebar/StatusBar 保持挂载，状态订阅不会中断。

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
  // 启动 PG/Ollama 状态订阅，仅执行一次（eslint-disable 防止 init 函数引用触发重新订阅）
  useEffect(() => {
    const cleanup = useAppStatusStore.getState().init();
    return cleanup;
  }, []);

  return (
    <div className="bg-background text-foreground flex h-screen w-screen flex-col overflow-hidden">
      <Topbar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
      <StatusBar />
    </div>
  );
}
