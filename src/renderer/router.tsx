// src/renderer/router.tsx
// React Router 7 Data Mode 路由配置
// 设计文档 §3 路由结构 + §5.3 React Router 7 Data Mode（非 Framework Mode）
//
// 职责：
// - 使用 createBrowserRouter（Data Mode）声明全应用路由
// - 根布局 root.tsx 挂载 AppShell（Topbar + Sidebar + StatusBar）
// - 业务路由全部使用 lazy 加载（代码分割）
// - 提供 RootErrorBoundary 作为顶层错误边界
//
// 路由树：
//   /                            → RootLayout (AppShell)
//     index                      → /projects（重定向到 /projects）
//     /projects                  → ProjectsPage
//     /settings                  → SettingsPage
//     /projects/:projectId       → ProjectShell (layout)
//       index                    → ChaptersPage（默认进入章节管理）
//       chapters                 → ChaptersPage
//       characters               → CharactersPage
//       worldview                → WorldviewPage
//       chat                     → ChatPage
//       rag                      → RagPage

import { createBrowserRouter, Navigate } from 'react-router';

import { RootErrorBoundary, RootLayout } from './routes/root';

/**
 * 应用路由配置
 *
 * 使用 RR7 Data Mode：createBrowserRouter + RouterProvider，
 * 在 App.tsx 中通过 <RouterProvider router={router} /> 挂载。
 *
 * lazy 加载策略：
 * - root 布局直接 import（启动时必须立即渲染，避免首屏白屏）
 * - 业务路由全部 lazy（按需加载，减少首屏 bundle 体积）
 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    errorElement: <RootErrorBoundary />,
    children: [
      // 根路径重定向到项目列表
      { index: true, element: <Navigate to="/projects" replace /> },
      // 项目列表（不依赖 :projectId）
      { path: 'projects', lazy: () => import('./routes/projects') },
      // 设置页（不依赖 :projectId）
      { path: 'settings', lazy: () => import('./routes/settings') },
      // 项目工作台（依赖 :projectId，包含 5 个子路由）
      {
        path: 'projects/:projectId',
        lazy: () => import('./routes/project-shell'),
        children: [
          // index 路由：默认进入章节管理（设计文档 §3）
          { index: true, lazy: () => import('./routes/chapters') },
          { path: 'chapters', lazy: () => import('./routes/chapters') },
          { path: 'characters', lazy: () => import('./routes/characters') },
          { path: 'worldview', lazy: () => import('./routes/worldview') },
          { path: 'chat', lazy: () => import('./routes/chat') },
          { path: 'rag', lazy: () => import('./routes/rag') },
        ],
      },
    ],
  },
]);
