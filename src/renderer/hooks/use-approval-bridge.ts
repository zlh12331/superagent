// src/renderer/hooks/use-approval-bridge.ts
// 审批桥接 Hook · 连接 IPC 推送与 approvals-store
// ──────────────────────────────────────────────────────────────
// 职责：
// - 订阅主进程 approval:request 事件，将 payload 转换为 ApprovalItem 入队 store
// - 在组件挂载时自动订阅，卸载时自动取消订阅
// （审批结果回传不在此 hook：由 InlineApprovalCard 按钮直接调用 approvalResponse）
//
// 设计：
// - 纯桥接层：不做业务决策（批准/拒绝由用户在 UI 中操作）
// - toolName → ApprovalType 的映射规则集中在此 hook，UI 组件不感知工具名
// - rememberDecision 由 InlineApprovalCard「批准并记住」按钮传入，透传到主进程
//
// 数据流：
//   主进程 ToolExecutor
//     ↓ agent:approval:request IPC 推送
//   useApprovalBridge（本 hook）
//     ↓ enqueue
//   useApprovalsStore.pending[]
//     ↓ 用户点击拒绝 / 批准并记住 / 批准（InlineApprovalCard）
//     ↓ agent:approval:response IPC 回传
//   主进程 PermissionService.handleApprovalResponse
// ──────────────────────────────────────────────────────────────

import { useEffect } from 'react';

import { type ApprovalType, useApprovalsStore } from '@/stores/transient/approvals-store';

/**
 * 审批请求 payload（从主进程推送过来）
 *
 * 与 packages/shared/src/schemas/agent.ts 的 AgentApprovalRequestPayload 对齐。
 * 此处独立定义而非从 shared 导入，是为了避免渲染层 preload 在沙箱环境下引入额外依赖。
 */
interface ApprovalRequestPayload {
  readonly sessionId: string;
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly description: string;
}

/**
 * toolName → ApprovalType 映射规则
 *
 * 按关键字匹配，命中即返回对应类型；全部未命中时回退到 'external_call'。
 * 映射逻辑集中在此处，便于后续扩展（如新增工具或调整规则）。
 */
function classifyTool(toolName: string): ApprovalType {
  const name = toolName.toLowerCase();
  // 顺序敏感：先匹配更具体的 Git 写操作，再匹配通用规则
  // Git 工具命名固定为 git_add / git_commit / git_push，用精确匹配避免误判
  if (name === 'git_push') {
    return 'git_push';
  }
  if (name === 'git_commit') {
    return 'git_commit';
  }
  if (name === 'git_add') {
    return 'git_add';
  }
  // 顺序敏感：先匹配更具体的（如 install_package 优先于 external_call）
  if (name.includes('install') || name.includes('npm') || name.includes('pip')) {
    return 'install_package';
  }
  if (name.includes('patch') || name.includes('diff')) {
    return 'apply_patch';
  }
  if (name.includes('delete') || name.includes('rm') || name.includes('remove')) {
    return 'delete_file';
  }
  if (name.includes('edit') || name.includes('replace') || name.includes('str_replace')) {
    return 'edit_file';
  }
  if (name.includes('write') || name.includes('create')) {
    return 'write_file';
  }
  if (
    name.includes('command') ||
    name.includes('bash') ||
    name.includes('shell') ||
    name.includes('exec')
  ) {
    return 'run_command';
  }
  // 兜底：MCP 工具 / 外部 API 调用等无法归类的工具
  return 'external_call';
}

/**
 * 审批桥接 Hook
 *
 * 在根组件挂载一次即可（AppShell）。
 * 纯订阅副作用：接 IPC approval:request 事件，入队到 useApprovalsStore；
 * 审批结果的回传由 InlineApprovalCard 直接调用 window.api.agent.approvalResponse。
 */
export function useApprovalBridge(): void {
  // 订阅 IPC approval:request 事件，将 payload 入队到 store
  useEffect(() => {
    if (typeof window === 'undefined' || window.api === undefined) {
      // SSR / 测试环境下 window.api 可能不存在，安全跳过
      return;
    }
    const unsubscribe = window.api.agent.subscribeApprovalRequest((payload) => {
      const typedPayload = payload as ApprovalRequestPayload;
      // 将 IPC payload 映射为 store ApprovalItem（status / resolvedAt 由 store 内部填充）
      useApprovalsStore.getState().enqueue({
        id: typedPayload.approvalId,
        sessionId: typedPayload.sessionId,
        type: classifyTool(typedPayload.toolName),
        title: typedPayload.toolName,
        description: typedPayload.description,
        input: typedPayload.input,
        createdAt: Date.now(),
      });
    });
    return unsubscribe;
  }, []);
}
