// src/renderer/hooks/use-agent-ask-bridge.ts
// Agent 提问桥接 Hook · 连接 IPC 推送与 agent-ask-store
// ──────────────────────────────────────────────────────────────
// 职责：
// - 订阅主进程 agent:event:ask 事件，将 payload 入队到 agent-ask-store
// - 订阅 agent:event:ask:resolved（决议事件）：超时等非用户路径把该提问
//   移出队列——否则弹窗永久残留，且队列化后会阻塞后续提问（2026-10-08）
// - 组件挂载时自动订阅，卸载时取消订阅
//
// 数据流：
//   主进程 ask_user_question 工具 → AgentAskService
//     ↓ agent:event:ask IPC 推送
//   useAgentAskBridge（本 hook）
//     ↓ enqueue
//   useAgentAskStore → AskDialog 渲染队头
//     ↓ 用户提交
//   window.api.agent.respondAsk 回传 → 主进程 resolve pending
//     ↓ agent:event:ask:resolved（超时/作答）→ removeAsk（配对闭合）
// ──────────────────────────────────────────────────────────────

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
      // sessionId 归属：多会话并发时按会话记录，回合结束按会话精确清理
      useAgentAskStore.getState().enqueue({
        sessionId: payload.sessionId,
        askId: payload.askId,
        questions: payload.questions,
        receivedAt: Date.now(),
      });
    });
    // 决议事件：非用户路径（超时/中断）放行队列——用户已自行提交时幂等 no-op
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
