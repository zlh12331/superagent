// src/renderer/components/layout/AppShell.tsx
// 应用主布局容器 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 职责：
// - 三段式布局：Topbar（44px）/ 主体（Sidebar + 内容区）
// - 内容区垂直布局：路由内容（main）+ DevPanel（可折叠底部面板）
// - 集成 ApprovalDialog：通过 useApprovalBridge 订阅 IPC 审批推送
//   - ApprovalDialog 作为根级兄弟节点渲染，确保任意路由下都能弹出
// - 集成 useToolBridge：订阅工具调用 IPC 事件写入 store
// - 集成 useTerminalBridge：订阅终端输出/退出 IPC 事件写入 store
//
// 文学风设计：
// - 整体米黄纸张底色
// - Topbar 暖米色（次要层级）
// - Sidebar 暖米色 + 浅边框
// - 内容区主色（最浅，最聚焦）
// - DevPanel 折叠为细条（28px），展开为 200px
// ──────────────────────────────────────────────────────────────

import type { ReactElement, ReactNode } from 'react';

import { ApprovalDialog } from '@/components/agent/ApprovalDialog';
import { useApprovalBridge } from '@/hooks/use-approval-bridge';
import { useTerminalBridge } from '@/hooks/use-terminal-bridge';
import { useToolBridge } from '@/hooks/use-tool-bridge';
import { DEFAULT_GIT_REPO_PATH, DRAFT_SESSION_ID } from '@/lib/constants';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';

import { DevPanel } from './DevPanel';
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
 * 主体水平排列 Sidebar + 内容区，内容区垂直排列 main + DevPanel。
 *
 * 集成 useApprovalBridge + ApprovalDialog：
 * - useApprovalBridge 订阅 agent:approval:request IPC 事件
 * - 审批项入队 useApprovalsStore.pending
 * - ApprovalDialog 读取 pending[0] 弹出对话框
 * - 用户点击批准/拒绝 → 调用 IPC agent.approvalResponse 回传主进程
 *
 * 集成 useToolBridge + useTerminalBridge：
 * - useToolBridge 订阅 agent:tool:call / agent:tool:result IPC 事件
 * - useTerminalBridge 订阅 terminal:event:output / terminal:event:exit IPC 事件
 * - 两者在根布局初始化一次，保证任意路由下都能接收事件
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

  // 终端桥接：订阅 terminal:event:output / terminal:event:exit IPC 事件
  // 将事件写入 useTerminalStore，供 TerminalPanel 兜底展示
  useTerminalBridge();

  // L2 Zustand：激活会话 id（用于关联 DevPanel 中的终端实例）
  // 无激活会话时使用 DRAFT_SESSION_ID 作为占位（复用同一个草稿终端）
  const activeSessionId = useActiveSessionStore((state) => state.activeSessionId);
  const devPanelSessionId = activeSessionId ?? DRAFT_SESSION_ID;

  return (
    <div className="bg-background text-foreground flex h-screen w-screen flex-col overflow-hidden font-sans">
      <Topbar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        {/* 内容区：垂直布局（路由内容 + 开发面板） */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <main className="paper-texture min-h-0 flex-1 overflow-auto bg-background">
            {children}
          </main>
          {/* 开发面板：Terminal + Git，可折叠底部面板 */}
          <DevPanel sessionId={devPanelSessionId} gitRepoPath={DEFAULT_GIT_REPO_PATH} />
        </div>
      </div>

      {/* 全局审批对话框：根级渲染，覆盖在所有内容之上 */}
      <ApprovalDialog onRespond={respondApproval} />
    </div>
  );
}
