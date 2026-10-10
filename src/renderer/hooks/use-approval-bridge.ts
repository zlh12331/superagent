import { useEffect } from 'react';
import { hasIpcBridge } from '@/lib/ipc';
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
 * 审批决议 payload（从主进程推送过来）
 *
 * 与 packages/shared/src/schemas/agent.ts 的 AgentApprovalResolvedPayload 对齐
 * （此处独立定义的理由同 ApprovalRequestPayload）。
 */
interface ApprovalResolvedPayload {
  readonly sessionId: string;
  readonly approvalId: string;
  readonly decision: 'approved' | 'denied' | 'timed-out' | 'aborted';
}

/**
 * toolName → ApprovalType 映射规则
 *
 * 按关键字匹配，命中即返回对应类型；全部未命中时回退到 'external_call'。
 * 映射逻辑集中在此处，便于后续扩展（如新增工具或调整规则）。
 */
function classifyTool(toolName: string): ApprovalType {
  const name = toolName.toLowerCase();
  if (name === 'git_push') {
    return 'git_push';
  }
  if (name === 'git_commit') {
    return 'git_commit';
  }
  if (name === 'git_add') {
    return 'git_add';
  }
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
  return 'external_call';
}

/**
 * 审批桥接 Hook
 *
 * 在根组件挂载一次即可（AppShell）。
 * 纯订阅副作用：接 IPC approval:request 事件，入队到 useApprovalsStore；
 * 审批结果的回传由 InlineApprovalCard 直接调用 window.api.agent.approvalResponse。
 *
 * 另订阅 approval:resolved（配对事件）：主进程在**非用户路径**（超时/中断）
 * 判定决议后回推，前端据此把条目移出待审批队列——此前无此通道，超时的审批
 * 会永久残留在界面上（2026-10-08 修复）。
 */
export function useApprovalBridge(): void {
  useEffect(() => {
    if (!hasIpcBridge()) {
      return;
    }
    const unsubscribeRequest = window.api.agent.subscribeApprovalRequest((payload) => {
      const typedPayload = payload as ApprovalRequestPayload;
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
    const unsubscribeResolved = window.api.agent.subscribeApprovalResolved((payload) => {
      const typed = payload as ApprovalResolvedPayload;
      if (typed.decision === 'timed-out' || typed.decision === 'aborted') {
        useApprovalsStore.getState().settleExternal(typed.approvalId, typed.decision);
      }
    });
    return () => {
      unsubscribeRequest();
      unsubscribeResolved();
    };
  }, []);
}
