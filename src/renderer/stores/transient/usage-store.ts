// src/renderer/stores/transient/usage-store.ts
// token 用量状态管理（L4 流式推送状态层 - transient，per-session 累积）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 按 sessionId 累积 token 使用量（agent:stream:end 携带 usage 时累加）
// - 提供 addUsage / clearBySession 原子操作
//
// 设计：
// - per-session 隔离：Map<sessionId, SessionUsage>（对齐参考设计的 per-tab 模式）
// - 累积计算放 store action（对齐参考设计 4.2.2：usage 累积放 store 内）
// - 不持久化：token 用量是运行时展示数据，会话历史中不包含
// ──────────────────────────────────────────────────────────────

import { create } from 'zustand';

/** 单会话累积 token 用量 */
export interface SessionUsage {
  /** 输入 token 累积 */
  readonly inputTokens: number;
  /** 输出 token 累积 */
  readonly outputTokens: number;
  /** 总 token 累积（input + output） */
  readonly totalTokens: number;
}

/** 单次回合的 usage 增量（可选字段，缺省视为 0） */
export interface UsageDelta {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

/** token 用量状态形状 */
interface UsageState {
  /** 会话 → 累积用量（per-session 隔离） */
  readonly usageBySession: ReadonlyMap<string, SessionUsage>;

  /** 累积一次回合用量（agent:stream:end 携带 usage 时调用） */
  readonly addUsage: (sessionId: string, delta: UsageDelta) => void;
  /** 清空指定会话的用量（会话切换/关闭时调用） */
  readonly clearBySession: (sessionId: string) => void;
}

/** 空用量常量（未累积过时返回） */
const EMPTY_USAGE: SessionUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/**
 * token 用量 store（per-session 累积）
 *
 * @example
 * ```tsx
 * const usage = useUsageStore((s) => s.usageBySession.get(sessionId) ?? EMPTY_USAGE);
 * ```
 */
export const useUsageStore = create<UsageState>()((set) => ({
  usageBySession: new Map<string, SessionUsage>(),

  addUsage: (sessionId, delta) =>
    set((state) => {
      const prev = state.usageBySession.get(sessionId) ?? EMPTY_USAGE;
      const next: SessionUsage = {
        inputTokens: prev.inputTokens + (delta.inputTokens ?? 0),
        outputTokens: prev.outputTokens + (delta.outputTokens ?? 0),
        totalTokens: prev.totalTokens + (delta.totalTokens ?? 0),
      };
      const nextMap = new Map(state.usageBySession);
      nextMap.set(sessionId, next);
      return { usageBySession: nextMap };
    }),

  clearBySession: (sessionId) =>
    set((state) => {
      const nextMap = new Map(state.usageBySession);
      nextMap.delete(sessionId);
      return { usageBySession: nextMap };
    }),
}));

/** 导出空用量常量（组件 selector 缺省值） */
export { EMPTY_USAGE };
