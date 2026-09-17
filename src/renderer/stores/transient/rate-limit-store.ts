// src/renderer/stores/transient/rate-limit-store.ts
// 限流提示状态（L2 客户端共享状态 - transient）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 记录最近一次 429 限流触发（agent/chat 回合失败时由 use-agent-bridge 写入）
// - RateLimitBanner 订阅本 store 渲染横幅（对齐参考项目 RateLimitBanner 语义）
// - 不持久化：限流提示是会话内瞬态
// ──────────────────────────────────────────────────────────────

import { create } from 'zustand';

/** 限流提示状态形状 */
interface RateLimitState {
  /** 是否显示限流横幅 */
  readonly visible: boolean;
  /** 触发时间戳（ms；用于横幅自动隐藏超时计算） */
  readonly triggeredAt: number;
  /** 触发限流（横幅显示；重置自动隐藏计时） */
  readonly trigger: () => void;
  /** 手动关闭横幅 */
  readonly dismiss: () => void;
}

/**
 * 横幅自动隐藏时长（ms）：限流窗口通常较短，5 分钟后自动消失避免永久占位
 *
 * 导出供横幅组件按「剩余时间」精确调度定时器（此前组件内另写一个 60s 轮询常量，
 * 与本节判定口径分离，二者不一致正是「到期不消失」bug 的成因）。
 */
export const AUTO_HIDE_MS = 5 * 60 * 1000;

/**
 * 限流提示 store
 */
export const useRateLimitStore = create<RateLimitState>()((set) => ({
  visible: false,
  triggeredAt: 0,

  trigger: () => set({ visible: true, triggeredAt: Date.now() }),
  dismiss: () => set({ visible: false, triggeredAt: 0 }),
}));

/** 横幅是否应自动隐藏（触发超过 AUTO_HIDE_MS 后由组件调用 dismiss） */
export function isRateLimitExpired(triggeredAt: number, now = Date.now()): boolean {
  return now - triggeredAt > AUTO_HIDE_MS;
}
