// （Copyright 2025 Qwen Team，SPDX-License-Identifier: Apache-2.0）的

/**
 * 拒绝跟踪状态
 */
export interface DenialState {
  /** 连续拒绝次数（用户放行后重置） */
  consecutiveDenials: number;
  /** 会话累计拒绝次数（不因放行重置） */
  totalDenials: number;
}

/** 拒绝降级阈值（对齐 qwen AUTO_MODE_DENIAL_LIMITS 收敛） */
export const DENIAL_LIMITS = {
  /** 连续拒绝 ≥ 3 次 → 降级手动确认 */
  maxConsecutiveDenials: 3,
  /** 累计拒绝 ≥ 20 次 → 降级手动确认（防止交替绕过连续阈值） */
  maxTotalDenials: 20,
} as const;

/** 初始状态（全零） */
export function createDenialState(): DenialState {
  return { consecutiveDenials: 0, totalDenials: 0 };
}

/**
 * 记录一次拒绝（用户拒绝了自动放行的工具调用）
 */
export function recordDenial(state: DenialState): DenialState {
  return {
    consecutiveDenials: state.consecutiveDenials + 1,
    totalDenials: state.totalDenials + 1,
  };
}

/**
 * 记录一次放行（用户批准或工具自动执行）：重置连续计数（累计保留）
 */
export function recordAllowance(state: DenialState): DenialState {
  return { consecutiveDenials: 0, totalDenials: state.totalDenials };
}

/**
 * 是否应降级为手动确认（连续或累计超阈值）
 */
export function shouldFallbackToManual(state: DenialState): boolean {
  return (
    state.consecutiveDenials >= DENIAL_LIMITS.maxConsecutiveDenials ||
    state.totalDenials >= DENIAL_LIMITS.maxTotalDenials
  );
}
