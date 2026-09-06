// src/main/infra/ai/denial-tracking.test.ts
// 拒绝跟踪状态机单测：拒绝/放行计数与降级阈值

import { describe, expect, it } from 'vitest';
import {
  createDenialState,
  DENIAL_LIMITS,
  recordAllowance,
  recordDenial,
  shouldFallbackToManual,
} from './denial-tracking';

describe('denial-tracking', () => {
  it('初始状态：全零，不降级', () => {
    const state = createDenialState();
    expect(state).toEqual({ consecutiveDenials: 0, totalDenials: 0 });
    expect(shouldFallbackToManual(state)).toBe(false);
  });

  it('连续拒绝：达到阈值（3 次）触发降级', () => {
    let state = createDenialState();
    state = recordDenial(state);
    state = recordDenial(state);
    expect(shouldFallbackToManual(state)).toBe(false);
    state = recordDenial(state);
    expect(shouldFallbackToManual(state)).toBe(true);
  });

  it('用户放行：重置连续计数，累计保留', () => {
    let state = createDenialState();
    state = recordDenial(state);
    state = recordDenial(state);
    state = recordAllowance(state);
    expect(state.consecutiveDenials).toBe(0);
    expect(state.totalDenials).toBe(2);
    expect(shouldFallbackToManual(state)).toBe(false);
  });

  it('累计拒绝：达到总阈值（20 次）触发降级（即使连续被重置）', () => {
    let state = createDenialState();
    for (let i = 0; i < DENIAL_LIMITS.maxTotalDenials; i += 1) {
      state = recordDenial(state);
      state = recordAllowance(state); // 每次放行重置连续计数
    }
    expect(state.consecutiveDenials).toBe(0);
    expect(state.totalDenials).toBe(DENIAL_LIMITS.maxTotalDenials);
    expect(shouldFallbackToManual(state)).toBe(true);
  });

  it('阈值常量：连续 3 / 累计 20', () => {
    expect(DENIAL_LIMITS.maxConsecutiveDenials).toBe(3);
    expect(DENIAL_LIMITS.maxTotalDenials).toBe(20);
  });
});
