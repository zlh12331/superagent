// src/renderer/components/layout/AppShell.tsx
// 应用主布局容器 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 职责：
// - 三段式布局：Topbar（44px）/ 主体（Sidebar + 内容区）
// - 集成 ApprovalDialog：通过 useApprovalBridge 订阅 IPC 审批推送
//   - ApprovalDialog 作为根级兄弟节点渲染，确保任意路由下都能弹出
//
// 文学风设计：
// - 整体米黄纸张底色
// - Topbar 暖米色（次要层级）
// - Sidebar 暖米色 + 浅边框
// - 内容区主色（最浅，最聚焦）
// ──────────────────────────────────────────────────────────────

import type { ReactElement, ReactNode } from 'react';

import { ApprovalDialog } from '@/components/agent/ApprovalDialog';
import { useApprovalBridge } from '@/hooks/use-approval-bridge';
import { useToolBridge } from '@/hooks/use-tool-bridge';

import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

interface AppShellProps {
  /** 主内容区（通常由 RouterProvider 通过 <Outlet /> 传入） */
  children: ReactNode;
}

/**
 * 应用主布局
 *
 * 使用 CSS Grid 划分两行：Topbar / 主体。
 * 主体水平排列 Sidebar + 内容区，Sidebar 固定宽度，内容区 flex-1。
 *
 * 集成 useApprovalBridge + ApprovalDialog：
 * - useApprovalBridge 订阅 agent:approval:request IPC 事件
 * - 审批项入队 useApprovalsStore.pending
 * - ApprovalDialog 读取 pending[0] 弹出对话框
 * - 用户点击批准/拒绝 → 调用 IPC agent.approvalResponse 回传主进程
 *
 * @example
 * ```tsx
 * <AppShell>
 *   <Outlet />
 * </AppShell>
 * ```
 */
export function AppShell({ children }: AppShellProps): ReactElement {
  // 审批桥接：订阅 IPC 推送 + 提供 respondApproval 方法
  // 在根布局初始化一次，保证任意路由下都能接收审批请求
  const { respondApproval } = useApprovalBridge();

  // 工具调用桥接：订阅 agent:tool:call / agent:tool:result IPC 事件
  // 将事件写入 useToolStore，供 ToolPanel 展示
  useToolBridge();

  return (
    <div className="bg-background text-foreground flex h-screen w-screen flex-col overflow-hidden font-sans">
      <Topbar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="paper-texture min-h-0 flex-1 overflow-auto bg-background">{children}</main>
      </div>

      {/* 全局审批对话框：根级渲染，覆盖在所有内容之上 */}
      <ApprovalDialog onRespond={respondApproval} />
    </div>
  );
}
