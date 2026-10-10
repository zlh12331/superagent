// denial-tracking.ts：审批拒绝计数——连续 3 次/累计 20 次拒绝即降级为手动模式（防 Agent 刷审批）
export interface DenialState {
  consecutiveDenials: number;
  totalDenials: number;
}

export const DENIAL_LIMITS = {
  maxConsecutiveDenials: 3,
  maxTotalDenials: 20,
} as const;

export function createDenialState(): DenialState {
  return { consecutiveDenials: 0, totalDenials: 0 };
}

export function recordDenial(state: DenialState): DenialState {
  return {
    consecutiveDenials: state.consecutiveDenials + 1,
    totalDenials: state.totalDenials + 1,
  };
}

export function recordAllowance(state: DenialState): DenialState {
  return { consecutiveDenials: 0, totalDenials: state.totalDenials };
}

export function shouldFallbackToManual(state: DenialState): boolean {
  return (
    state.consecutiveDenials >= DENIAL_LIMITS.maxConsecutiveDenials ||
    state.totalDenials >= DENIAL_LIMITS.maxTotalDenials
  );
}
