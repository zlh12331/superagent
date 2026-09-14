// src/renderer/router.tsx
// React Router 8 Data Mode 路由配置
// 设计文档 §3 路由结构 + §5.3 React Router 8 Data Mode（非 Framework Mode）
//
// 职责：
// - 使用 createHashRouter（Data Mode）声明全应用路由（hash 而非 history 的原因见下方路由配置注释）
// - 根布局 root.tsx 挂载 AppShell（Topbar + Sidebar + 内容区）
// - index 路由渲染 HomePage（欢迎页：品牌区 + 输入框 + 快捷动作 + 项目选择）
// - /chat/:sessionId 路由渲染 ChatPage（历史会话续传，内部渲染 ChatPanel）
// - 提供 RootErrorBoundary 作为顶层错误边界
//
// 路由树：
//   /                            → RootLayout (AppShell)
//     index                      → HomePage（欢迎页 / 新会话创建入口）
//     /chat/:sessionId           → ChatPage（历史会话，chatId=sessionId）
//
// 说明：
// - HomePage 创建会话后跳转 /chat/:id，ChatPanel 仅在聊天路由渲染
// - useChat 通过 chatId 隔离消息状态，切换时自动重置
// - AppShell 中已集成 AskDialog，所有路由下都能接收 Agent 提问

import { createHashRouter } from 'react-router';

import { ROUTES } from '@/lib/constants';
import { RootErrorBoundary, RootHydrateFallback, RootLayout } from './routes/root';

/**
 * 应用路由配置
 *
 * 使用 RR8 Data Mode：createHashRouter + RouterProvider。
 * hash 路由原因：生产构建以 file:// 加载（Electron loadFile），history 路由
 * 在 file:// 下 pathname 为文件路径导致全部路由 404（真实缺陷，2026-08-11
 * 由生产启动基准暴露）；hash 路由在 dev（http）与生产（file）均正常工作。
 *
 * 代码分割：HomePage / ChatPage 使用 route.lazy 按需加载，
 * 首屏 bundle 不再包含 shiki / diff-viewer / virtuoso 等重型依赖；
 * 加载期间由 root 路由的 HydrateFallback 提供占位。
 */
export const router = createHashRouter([
  {
    path: ROUTES.home,
    element: <RootLayout />,
    errorElement: <RootErrorBoundary />,
    // biome-ignore lint/style/useNamingConvention: React Router 8 路由 API 要求 PascalCase 属性名
    HydrateFallback: RootHydrateFallback,
    children: [
      // 首页：欢迎页（品牌区 + composer + 快捷动作）
      {
        index: true,
        lazy: async () => {
          const { HomePage } = await import('./routes/home');
          // biome-ignore lint/style/useNamingConvention: React Router lazy 要求模块导出 Component
          return { Component: HomePage };
        },
      },
      // 聊天页：历史会话续传（chatId=URL 参数 sessionId）
      {
        path: ROUTES.chat,
        lazy: async () => {
          const { ChatPage } = await import('./routes/chat');
          // biome-ignore lint/style/useNamingConvention: React Router lazy 要求模块导出 Component
          return { Component: ChatPage };
        },
      },
    ],
  },
]);
