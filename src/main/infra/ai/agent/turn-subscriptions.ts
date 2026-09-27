// src/main/infra/ai/agent/turn-subscriptions.ts
// 回合期订阅装配（2026-09-27 从 agent-service 提取，保持宿主体量在棘轮基线内）
// ──────────────────────────────────────────────────────────────
// - subscribeApprovalLifecycle：审批生命周期 → 回合状态机（waitingApproval 数据源）
// - subscribeTurnAccumulators：TEXT_DELTA 拼接助手全文 + TOOL_CALL 转录入转录表
// 行为与原 streamToWebContents 内联实现逐行等价（提取不改变订阅时机与退订语义）。
// ──────────────────────────────────────────────────────────────

import type { TurnTextDeltaEvent, TurnToolCallEvent } from '@code-agent/shared/main';
import { TurnEventType } from '@code-agent/shared/main';
import type { TurnEventEmitter } from '../agent-runtime';
import type { createAgentTurnActor } from '../agent-runtime/agent-turn-machine';
import type { TurnTranscriptEntry } from '../agent-runtime/turn-transcript';
import type { IPermissionService } from '../tools/permission-service';

/**
 * 审批生命周期订阅（waitingApproval 状态运行时数据源）
 *
 * 审批推送 → waitingApproval；决议完成 → 恢复 running（按 sessionId 过滤）。
 */
export function subscribeApprovalLifecycle(
  permissionService: IPermissionService | undefined,
  sessionId: string,
  turnMachine: ReturnType<typeof createAgentTurnActor>,
): (() => void) | undefined {
  return permissionService?.onApprovalLifecycle({
    onRequested: (p) => {
      if (p.sessionId === sessionId) {
        turnMachine.send({ type: 'approval.requested', approvalId: p.approvalId });
      }
    },
    onResolved: (p) => {
      if (p.sessionId === sessionId) {
        turnMachine.send({ type: 'approval.responded' });
      }
    },
  });
}

/**
 * 回合事件累积订阅：TEXT_DELTA 拼接助手全文；TOOL_CALL 转录入转录表
 *
 * 返回合并退订函数（回合结束 finally 调用）。
 */
export function subscribeTurnAccumulators(
  emitter: TurnEventEmitter,
  sinks: {
    readonly onTextDelta: (text: string) => void;
    readonly onToolCall: (entry: TurnTranscriptEntry) => void;
  },
): () => void {
  const offText = emitter.on(TurnEventType.TEXT_DELTA, (event) => {
    sinks.onTextDelta((event as TurnTextDeltaEvent).text);
  });
  // 工具调用转录（tool-call：模型发起，含入参；结果在 executeHook 处累积 output）
  const offToolCall = emitter.on(TurnEventType.TOOL_CALL, (event) => {
    const e = event as TurnToolCallEvent;
    sinks.onToolCall({
      kind: 'tool-call',
      toolCallId: e.toolCallId,
      toolName: e.toolName,
      input: e.input,
    });
  });
  return () => {
    offText();
    offToolCall();
  };
}
