// src/renderer/router.tsx
// React Router 8 Data Mode 路由配置
// 设计文档 §3 路由结构 + §5.3 React Router 8 Data Mode（非 Framework Mode）
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
//
// RR8 升级要点（相对 RR7）：
// - react-router-dom 已合并回 react-router（项目本就用 react-router，无影响）
// - v8 future flags 移除并转为默认行为（项目未启用任何 future flag）
// - createBrowserRouter / RouterProvider / Outlet / useRouteError API 保持兼容

import { createBrowserRouter } from 'react-router';

import { HomePage } from './routes/home';
import { RootErrorBoundary, RootLayout } from './routes/root';

/**
 * 应用路由配置
 *
 * 使用 RR8 Data Mode：createBrowserRouter + RouterProvider，
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
