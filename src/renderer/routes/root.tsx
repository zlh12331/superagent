// src/renderer/routes/root.tsx
// 根布局路由
// 设计文档 §3 路由结构 + §4 AppShell 布局
//
// 职责：
// - 挂载 AppShell（Topbar + Sidebar + StatusBar）
// - 通过 <Outlet /> 渲染子路由内容
// - 提供 errorElement 处理子路由抛出的错误
//
// 注意：root 不使用 lazy 加载（启动时必须立即渲染，避免首屏白屏）。
// 错误边界使用简单的回退 UI，避免 React Router 默认错误堆栈。

import type { ReactElement } from 'react';
import { isRouteErrorResponse, Outlet, useRouteError } from 'react-router';

import { AppShell } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';

/**
 * 根布局组件
 *
 * 在 createBrowserRouter 中作为顶层路由的 element，
 * 其 children（projects/settings/project-shell 等）通过 <Outlet /> 渲染。
 */
export function RootLayout(): ReactElement {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

/**
 * 根路由错误边界
 *
 * 子路由抛出未捕获错误（如 IPC 异常、组件崩溃）时由 React Router 捕获，
 * 此处展示简单回退 UI：
 * - 路由错误（404/Loader 失败）：显示状态码与提示
 * - 其他错误：显示错误消息与"重试"按钮
 */
export function RootErrorBoundary(): ReactElement {
  const error = useRouteError();

  if (isRouteErrorResponse(error)) {
    return (
      <div className="text-foreground flex h-full flex-col items-center justify-center gap-3 p-8">
        <h2 className="text-lg font-semibold">{error.status} 错误</h2>
        <p className="text-muted-foreground text-sm">{error.statusText || '页面加载失败'}</p>
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
          重新加载
        </Button>
      </div>
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="text-foreground flex h-full flex-col items-center justify-center gap-3 p-8">
      <h2 className="text-lg font-semibold">页面出错了</h2>
      <p className="text-muted-foreground max-w-md text-center text-sm">{message}</p>
      <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
        重新加载
      </Button>
    </div>
  );
}
