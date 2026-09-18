// src/renderer/stores/transient/agent-run-store.ts
// Agent 回合运行态（L2 transient：跨组件只读）
// ──────────────────────────────────────────────────────────────
// 职责：把 ChatPanel 的流式 status 提升为全局可读信号——"重启并安装"这类
// 危险操作需要知道当前是否有回合在跑（先确认再执行，见 use-install-update）。
// 设计：单一写入口（仅 ChatPanel 发布）+ 多读入口；非持久化，ChatPanel 卸载
// 时复位，避免残留 true 让后续安装永远多一次确认。
// ──────────────────────────────────────────────────────────────

import { create } from 'zustand';

/** 运行态 store 接口 */
interface AgentRunState {
  /** 是否有回合在流式执行（status 为 streaming / submitted） */
  readonly running: boolean;
  /** 发布运行态（仅 ChatPanel 调用） */
  readonly setRunning: (running: boolean) => void;
}

export const useAgentRunStore = create<AgentRunState>()((set) => ({
  running: false,
  setRunning: (running) => set({ running }),
}));
