// src/renderer/router.tsx
// React Router 8 Data Mode 路由配置
// 设计文档 §3 路由结构 + §5.3 React Router 8 Data Mode（非 Framework Mode）
//
// 职责：
// - 使用 createBrowserRouter（Data Mode）声明全应用路由
// - 根布局 root.tsx 挂载 AppShell（Topbar + Sidebar + 内容区）
// - index 路由渲染 HomePage（新对话草稿区，直接渲染 ChatPanel）
// - /chat/:sessionId 路由渲染 ChatPage（历史会话续传）
// - /novel 路由渲染 NovelHome（写作项目列表）
// - /novel/project/:id 路由渲染 NovelLayout（三栏写作工作台）
// - 提供 RootErrorBoundary 作为顶层错误边界
//
// 路由树：
//   /                            → RootLayout (AppShell)
//     index                      → HomePage（新对话草稿，chatId='draft'）
//     /chat/:sessionId           → ChatPage（历史会话，chatId=sessionId）
//     /novel                     → NovelHome（写作项目列表）
//     /novel/project/:id         → NovelLayout（写作工作台）
//       index                    → NovelEditor（编辑器页面）
//
// 说明：
// - HomePage 和 ChatPage 都渲染 ChatPanel，仅 chatId 不同
// - useChat 通过 chatId 隔离消息状态，切换时自动重置
// - AppShell 中已集成 ApprovalDialog，所有路由下都能接收审批请求

import { createBrowserRouter } from 'react-router';

import { ROUTES } from '@/lib/constants';
import { ChatPage } from './routes/chat';
import { HomePage } from './routes/home';
import { NovelHome } from './routes/novel/NovelHome';
import { NovelLayout } from './routes/novel/NovelLayout';
import { NovelEditor } from './routes/novel/NovelEditor';
import { RootErrorBoundary, RootLayout } from './routes/root';

/**
 * 应用路由配置
 *
 * 使用 RR8 Data Mode：createBrowserRouter + RouterProvider，
 * 在 App.tsx 中通过 <RouterProvider router={router} /> 挂载。
 */
export const router = createBrowserRouter([
  {
    path: ROUTES.home,
    element: <RootLayout />,
    errorElement: <RootErrorBoundary />,
    children: [
      // 首页：新对话草稿区（直接渲染 ChatPanel，chatId='draft'）
      { index: true, element: <HomePage /> },
      // 聊天页：历史会话续传（chatId=URL 参数 sessionId）
      { path: ROUTES.chat, element: <ChatPage /> },
      // 写作项目列表
      { path: ROUTES.novel, element: <NovelHome /> },
      // 写作工作台（三栏布局）
      {
        path: ROUTES.novelProject,
        element: <NovelLayout />,
        children: [
          { index: true, element: <NovelEditor /> },
        ],
      },
    ],
  },
]);
