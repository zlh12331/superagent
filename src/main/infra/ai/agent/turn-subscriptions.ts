import type { TurnTextDeltaEvent, TurnToolCallEvent } from '@code-agent/shared/main';
import { TurnEventType } from '@code-agent/shared/main';
import type { TurnEventEmitter } from '../agent-runtime';
import type { createAgentTurnActor } from '../agent-runtime/agent-turn-machine';
import type { TurnTranscriptEntry } from '../agent-runtime/turn-transcript';
import type { IPermissionService } from '../tools/permission-service';
import type { AgentAskService } from './agent-ask-service';

/**
 * 审批生命周期订阅（waitingApproval 状态运行时数据源）
 *
 * 审批推送 → waitingApproval；决议完成 → 恢复 running（按 sessionId 过滤）。
 * 返回 permissionService 提供的退订函数；permissionService 缺席（未注入）时
 * 返回 undefined——调用方须容忍该分支（无审批服务即无 waitingApproval 状态）。
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
        turnMachine.send({
          type: 'approval.responded',
          approvalId: p.approvalId,
          decision: p.decision,
        });
      }
    },
  });
}

/**
 * 提问生命周期订阅（waitingInput 状态运行时数据源，38 号阶段 2 收尾）
 *
 * 提问推送 → waitingInput；回答/超时完成 → 回 streaming（按 sessionId 过滤）。
 * 与 subscribeApprovalLifecycle 同构：此前机器不感知提问，挂起期间显示 streaming。
 * 恒返回退订函数（askService 为模块单例，不缺席）。
 */
export function subscribeAskLifecycle(
  askService: AgentAskService,
  sessionId: string,
  turnMachine: ReturnType<typeof createAgentTurnActor>,
): () => void {
  return askService.onAskLifecycle({
    onRequested: (p) => {
      if (p.sessionId === sessionId) {
        turnMachine.send({ type: 'ask.requested', askId: p.askId });
      }
    },
    onResolved: (p) => {
      if (p.sessionId === sessionId) {
        if (p.decision !== 'aborted') {
          turnMachine.send({ type: 'ask.responded', askId: p.askId, decision: p.decision });
        }
      }
    },
  });
}

/**
 * 回合事件累积订阅：TEXT_DELTA 拼接助手全文；TOOL_CALL 转录入转录表
 *
 * 返回合并退订函数（回合收尾 cleanup 出口调用）：内部一次性摘除 TEXT_DELTA 与
 * TOOL_CALL 两个监听器，调用方无需分别持有。
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
