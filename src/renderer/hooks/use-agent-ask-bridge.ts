import { useEffect } from 'react';
import { hasIpcBridge } from '@/lib/ipc';
import type { AgentAskEventPayload } from '@/stores/transient/agent-ask-store';
import { useAgentAskStore } from '@/stores/transient/agent-ask-store';

/** 提问决议事件 payload（与主进程 agent:event:ask:resolved 推送对齐） */
interface AskResolvedEventPayload {
  readonly sessionId: string;
  readonly askId: string;
  readonly decision: 'answered' | 'timed-out' | 'aborted';
}

/**
 * 订阅 Agent 提问事件（AppShell 挂载）
 */
export function useAgentAskBridge(): void {
  useEffect(() => {
    if (!hasIpcBridge()) {
      return;
    }
    const unsubscribeAsk = window.api.agent.subscribeAsk((payload: AgentAskEventPayload) => {
      useAgentAskStore.getState().enqueue({
        sessionId: payload.sessionId,
        askId: payload.askId,
        questions: payload.questions,
        receivedAt: Date.now(),
      });
    });
    const unsubscribeResolved = window.api.agent.subscribeAskResolved(
      (payload: AskResolvedEventPayload) => {
        if (payload.decision === 'timed-out' || payload.decision === 'aborted') {
          useAgentAskStore.getState().removeAsk(payload.askId);
        }
      },
    );
    return () => {
      unsubscribeAsk();
      unsubscribeResolved();
    };
  }, []);
}
