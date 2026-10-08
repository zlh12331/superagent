// src/renderer/stores/transient/agent-ask-store.ts
// Agent 交互式提问状态（L2 transient：ask_user_question 工具 → 提问对话框）
// ──────────────────────────────────────────────────────────────
// 主进程 agent:event:ask 推送 → 本 store 入队 → AskDialog 渲染队头
// 用户回答 → window.api.agent.respondAsk 回传 → 出队
// 主进程决议（agent:event:ask:resolved）→ 超时/中断路径出队（配对闭合）
// ──────────────────────────────────────────────────────────────
//
// 队列语义（2026-10-08 队列化）：一轮模型回复可含多个 ask 工具调用（AI SDK
// 并行执行），故 store 持有 pending 列表而非单值——此前单值会被后到的提问
// 覆盖，先到的那个永远看不到（且主进程侧已对称修复为 pendingAskIds 列表）。
// AskDialog 为全屏模态，一次呈现**队头**（FIFO 先问先答）；队头出队后下一条
// 自动上浮——超时的队头由主进程决议事件放行，不会阻塞队列。

import type { AgentQuestion } from '@code-agent/shared/renderer';
import { create } from 'zustand';

/** 一条待答提问（一次提问 = 一组问题） */
export interface PendingAskItem {
  /** 归属会话 id（并发回合互不串扰；回合结束按会话精确清理） */
  readonly sessionId: string;
  /** 提问 id（主进程关联 pending；回传时原样带回） */
  readonly askId: string;
  /** 问题列表（一次可多问） */
  readonly questions: readonly AgentQuestion[];
  /** 收到时间戳（ms；对话框超时倒计时基准） */
  readonly receivedAt: number;
}

/** 提问队列状态 */
interface AgentAskState {
  /** 待答提问队列（按到达顺序 FIFO，先问先答） */
  readonly asks: readonly PendingAskItem[];
  /** 入队新提问（主进程 agent:event:ask 推送时调用） */
  readonly enqueue: (item: PendingAskItem) => void;
  /**
   * 按 askId 出队（用户作答成功后调用）
   *
   * 幂等：id 不存在时静默 no-op（重复调用/已被决议事件移出）。
   */
  readonly removeAsk: (askId: string) => void;
  /**
   * 清空提问：传 sessionId 时仅清匹配会话（回合结束精确清理，并发回合
   * A 结束不清 B 的弹窗）；缺省全局清（向后兼容：无会话归属的旧调用）
   */
  readonly clearAsk: (sessionId?: string) => void;
}

/** 提问事件 Payload 类型（与主进程 agent:event:ask 推送对齐） */
export interface AgentAskEventPayload {
  /** 发起提问的会话 id */
  readonly sessionId: string;
  readonly askId: string;
  readonly questions: readonly AgentQuestion[];
}

export const useAgentAskStore = create<AgentAskState>((set, get) => ({
  asks: [],
  enqueue: (item) => set((state) => ({ asks: [...state.asks, item] })),
  removeAsk: (askId) => set((state) => ({ asks: state.asks.filter((a) => a.askId !== askId) })),
  clearAsk: (sessionId) => {
    if (sessionId === undefined) {
      set({ asks: [] });
      return;
    }
    // 会话清理：仅移除该会话的条目（其余会话的提问不受影响）
    const remaining = get().asks.filter((a) => a.sessionId !== sessionId);
    if (remaining.length !== get().asks.length) {
      set({ asks: remaining });
    }
  },
}));
