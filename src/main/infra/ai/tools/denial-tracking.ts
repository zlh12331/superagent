// src/main/infra/ai/denial-tracking.ts
// AUTO 模式拒绝跟踪状态机（信任衰减守卫）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 跟踪 auto 模式下用户的拒绝次数（连续 / 累计）
// - 超阈值 → 下一次工具调用降级为手动确认（单次降级，会话保持 auto）
// - 防止"模型反复尝试被拒操作"形成死循环
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/core/src/permissions/denialTracking.ts
// （Copyright 2025 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// AUTO_MODE_DENIAL_LIMITS / createDenialState / recordDenial 状态机语义，
// 按我们的技术栈收敛重写：
// - 我们无 LLM 分类器（无 unavailable 概念）：合并为单一拒绝计数
// - 阈值对齐 qwen 的 maxConsecutiveBlock=3 / maxTotalDenials=20
// - 增加 recordAllowance（用户放行重置连续计数，对齐 qwen 交叉重置语义）
// ──────────────────────────────────────────────────────────────

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
