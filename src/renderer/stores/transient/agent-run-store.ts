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
