// src/renderer/stores/transient/agent-ask-store.ts
// Agent 交互式提问状态（L2 transient：ask_user_question 工具 → 提问对话框）
// ──────────────────────────────────────────────────────────────
// 主进程 agent:event:ask 推送 → 本 store 记录当前提问 → AskDialog 渲染
// 用户回答 → window.api.agent.respondAsk 回传 → 清空
// ──────────────────────────────────────────────────────────────

import type { AgentQuestion } from '@code-agent/shared/renderer';
import { create } from 'zustand';

/** 当前提问（单实例：一次只展示一组问题） */
interface AgentAskState {
  /** 提问 id（主进程关联 pending） */
  readonly askId: string | null;
  /** 问题列表（一次可多问） */
  readonly questions: readonly AgentQuestion[];
  /** 收到新提问 */
  setAsk: (askId: string, questions: readonly AgentQuestion[]) => void;
  /** 清空当前提问（已提交/取消） */
  clearAsk: () => void;
}

/** 提问事件 Payload 类型（与主进程 agent:event:ask 推送对齐） */
export interface AgentAskEventPayload {
  readonly askId: string;
  readonly questions: readonly AgentQuestion[];
}

export const useAgentAskStore = create<AgentAskState>((set) => ({
  askId: null,
  questions: [],
  setAsk: (askId, questions) => set({ askId, questions }),
  clearAsk: () => set({ askId: null, questions: [] }),
}));
