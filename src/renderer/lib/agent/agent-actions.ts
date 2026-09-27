// src/renderer/lib/agent/agent-actions.ts
// Agent 交互动作 IPC 桥（respondAsk / approvalResponse）
// ──────────────────────────────────────────────────────────────
// 职责（direct-ipc 清迁，2026-09-26）：
// - 提问回传与审批响应此前写在 ask-dialog / inline-approval-card 组件内，
//   违反「.tsx 不直连 window.api」；收敛到 lib/agent（桥接层豁免）
// - 与 ipc-agent-transport 的分工：transport 管流式回合，本文件管单次动作
// ──────────────────────────────────────────────────────────────

import type { AgentAnswer, AgentApprovalResponseReq } from '@code-agent/shared/renderer';

import { hasIpcBridge, unwrap } from '@/lib/ipc';

/**
 * 回传 Agent 提问答案（ask_user_question 工具的渲染层出口）
 *
 * @throws Error 无桥、IPC 错误响应或协议异常（消息带 [CODE] 前缀，供 unwrapErrorMessage 本地化）
 */
export async function respondAgentAsk(params: {
  readonly askId: string;
  readonly answers: readonly AgentAnswer[];
}): Promise<void> {
  if (!hasIpcBridge()) {
    throw new Error('[NO_BRIDGE] window.api unavailable');
  }
  unwrap(
    await window.api.agent.respondAsk({
      askId: params.askId,
      answers: [...params.answers],
    }),
  );
}

/**
 * 发送审批响应（批准 / 拒绝，可附 rememberDecision）
 *
 * @returns 是否成功（失败时主进程侧 5 分钟超时兜底仍生效）
 */
export async function sendApprovalResponse(params: AgentApprovalResponseReq): Promise<boolean> {
  if (!hasIpcBridge()) {
    return false;
  }
  try {
    unwrap(await window.api.agent.approvalResponse(params));
    return true;
  } catch {
    return false;
  }
}
