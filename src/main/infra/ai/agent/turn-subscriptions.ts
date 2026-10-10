import type { TurnTextDeltaEvent, TurnToolCallEvent } from '@code-agent/shared/main';
import { TurnEventType } from '@code-agent/shared/main';
import type { TurnEventEmitter } from '../agent-runtime';
import type { createAgentTurnActor } from '../agent-runtime/agent-turn-machine';
import type { TurnTranscriptEntry } from '../agent-runtime/turn-transcript';
import type { IPermissionService } from '../tools/permission-service';
import type { AgentAskService } from './agent-ask-service';

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
