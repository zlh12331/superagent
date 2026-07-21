// src/renderer/App.tsx
// 渲染层根组件
// 设计文档 §3 应用入口 + §5.3 React Router 7 Data Mode
//
// 职责：
// - 包裹应用 Provider（Theme / Tooltip / Toaster）
// - 挂载 RouterProvider（RR7 Data Mode，由 router.tsx 配置）
// - 外层包裹 AppErrorBoundary 兜底（P1-4 分层错误边界第 1 层）
//
// 注意：main.tsx 仅负责挂载根节点 + StrictMode + index.css，
// 所有 Provider 与路由都由此组件组装，保持 main.tsx 简洁。

import type { ReactElement } from 'react';
import { RouterProvider } from 'react-router';

import { AppErrorBoundary } from './components/common/AppErrorBoundary';
import { AppProviders } from './providers';
import { router } from './router';

/**
 * 渲染层根组件
 *
 * Provider 嵌套顺序（外 → 内）：
 * 1. AppErrorBoundary：App 级错误边界，全屏兜底（P1-4 第 1 层）
 * 2. AppProviders：Theme / Tooltip / Toaster
 * 3. RouterProvider：路由配置（lazy 加载业务路由）
 *    - 路由层错误由 RootErrorBoundary 捕获（P1-4 第 2 层）
 *    - 业务组件层错误由 SectionErrorBoundary 捕获（P1-4 第 3 层）
 *
 * 在 main.tsx 中通过 createRoot 挂载到 #root 节点。
 */
export default function App(): ReactElement {
  return (
    <AppErrorBoundary>
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>
    </AppErrorBoundary>
  );
}
