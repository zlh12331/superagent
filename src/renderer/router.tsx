// src/renderer/router.tsx
// React Router 7 Data Mode 路由配置
// 设计文档 §3 路由结构 + §5.3 React Router 7 Data Mode（非 Framework Mode）
//
// 职责：
// - 使用 createBrowserRouter（Data Mode）声明全应用路由
// - 根布局 root.tsx 挂载 AppShell（Topbar + 内容区）
// - index 路由直接渲染 HomePage（占位首页）
// - 提供 RootErrorBoundary 作为顶层错误边界
//
// 说明：原业务路由（projects/settings/chapters/characters/worldview/chat/rag）
// 已随数据库层一并删除。当前仅保留根布局 + 占位首页，作为 Electron 模版骨架。
// 后续若重建业务后端，在 children 中追加 lazy 路由即可。

import { createBrowserRouter } from 'react-router';

import { HomePage } from './routes/home';
import { RootErrorBoundary, RootLayout } from './routes/root';

/**
 * 应用路由配置
 *
 * 使用 RR7 Data Mode：createBrowserRouter + RouterProvider，
 * 在 App.tsx 中通过 <RouterProvider router={router} /> 挂载。
 *
 * 当前路由树：
 *   /                            → RootLayout (AppShell)
 *     index                      → HomePage（占位首页，非 lazy 加载）
 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    errorElement: <RootErrorBoundary />,
    children: [
      // index 路由：直接渲染占位首页（无业务路由可懒加载）
      { index: true, element: <HomePage /> },
    ],
  },
]);
