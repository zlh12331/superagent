// src/renderer/hooks/use-agent-ask-bridge.ts
// Agent 提问桥接 Hook · 连接 IPC 推送与 agent-ask-store
// ──────────────────────────────────────────────────────────────
// 职责：
// - 订阅主进程 agent:event:ask 事件，将 payload 写入 agent-ask-store
// - 组件挂载时自动订阅，卸载时取消订阅
//
// 数据流：
//   主进程 ask_user_question 工具 → AgentAskService
//     ↓ agent:event:ask IPC 推送
//   useAgentAskBridge（本 hook）
//     ↓ setAsk
//   useAgentAskStore → AskDialog 渲染
//     ↓ 用户提交
//   window.api.agent.respondAsk 回传 → 主进程 resolve pending
// ──────────────────────────────────────────────────────────────

import { useEffect } from 'react';
import type { AgentAskEventPayload } from '@/stores/transient/agent-ask-store';
import { useAgentAskStore } from '@/stores/transient/agent-ask-store';

/**
 * 订阅 Agent 提问事件（AppShell 挂载）
 */
export function useAgentAskBridge(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || window.api === undefined) {
      return;
    }
    const unsubscribe = window.api.agent.subscribeAsk((payload: AgentAskEventPayload) => {
      // sessionId 归属：多会话并发时按会话记录，回合结束按会话精确清理
      useAgentAskStore.getState().setAsk(payload.sessionId, payload.askId, payload.questions);
    });
    return unsubscribe;
  }, []);
}
