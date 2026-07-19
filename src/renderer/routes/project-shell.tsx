// src/renderer/routes/project-shell.tsx
// 项目工作台布局路由（/projects/:projectId 子路由的父布局）
// 设计文档 §3 路由结构
//
// 职责：
// - 通过 <Outlet /> 渲染项目子路由（chapters/characters/worldview/chat/rag）
// - 提供 errorElement 处理子路由抛出的错误
// - 后续 Phase 8 可在此处加载项目详情数据（loader）供子路由共享
//
// 注意：当前 Phase 7 仅作为布局占位，不实现数据加载逻辑。
// index 路由指向 chapters.tsx（设计文档 §3 默认进入「章节管理」）。

import type { ReactElement } from 'react';
import { Outlet } from 'react-router';

/**
 * 项目工作台布局组件
 *
 * 在 createBrowserRouter 中作为 /projects/:projectId 路由的 element，
 * 其 children（chapters/characters/worldview/chat/rag）通过 <Outlet /> 渲染。
 *
 * index 路由指向 chapters，访问 /projects/:projectId 时默认进入章节管理。
 */
export function Component(): ReactElement {
  return <Outlet />;
}

Component.displayName = 'ProjectShell';
