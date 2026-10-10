import { create } from 'zustand';

/** 单会话回合错误条目 */
export interface TurnErrorEntry {
  /** 错误码（与 ErrorCode 对齐；未经分类的兜底路径写 'UNKNOWN'） */
  readonly code: string;
  /** 错误详情（主进程权威消息；可能含远端服务原文，如网关返回的拒绝原因） */
  readonly message: string;
  /** 记录时间戳（ms） */
  readonly at: number;
}

/** 回合错误状态形状 */
interface TurnErrorState {
  /** 会话 id → 最近一次回合错误（并发会话按 id 隔离，互不覆盖） */
  readonly errors: Readonly<Record<string, TurnErrorEntry>>;
  /**
   * 权威写入（use-agent-bridge 的 stream-error 载荷）
   *
   * 覆盖既有条目——同一回合的先后事件以最近一次为准。
   */
  readonly set: (sessionId: string, code: string, message: string) => void;
  /**
   * 兜底写入：仅当该会话当前无条目时生效
   *
   * useChat onError 与权威载荷（IPC 事件）的触发顺序不确定，且 onError 持有的
   * 文案可能已被 SDK 脱敏（'An error occurred.'）——已有权威条目时不得覆盖；
   * 无条目时（如 invoke 阶段即失败、未产生 stream-error 事件）兜底显示。
   */
  readonly ensure: (sessionId: string, code: string, message: string) => void;
  /** 清除指定会话的错误（手动关闭 / 下一回合开始） */
  readonly clear: (sessionId: string) => void;
}

/**
 * 回合错误 store（transient）
 */
export const useTurnErrorStore = create<TurnErrorState>()((set, get) => ({
  errors: {},

  set: (sessionId, code, message) =>
    set((state) => ({
      errors: { ...state.errors, [sessionId]: { code, message, at: Date.now() } },
    })),

  ensure: (sessionId, code, message) => {
    if (get().errors[sessionId] !== undefined) return;
    set((state) => ({
      errors: { ...state.errors, [sessionId]: { code, message, at: Date.now() } },
    }));
  },

  clear: (sessionId) =>
    set((state) => {
      if (state.errors[sessionId] === undefined) return state;
      return {
        errors: Object.fromEntries(Object.entries(state.errors).filter(([id]) => id !== sessionId)),
      };
    }),
}));
