// src/renderer/stores/transient/__tests__/rate-limit-store.test.ts
// 限流提示 store 单测：触发/关闭/自动过期判定

import { beforeEach, describe, expect, it } from 'vitest';
import { isRateLimitExpired, useRateLimitStore } from '../rate-limit-store';

describe('useRateLimitStore', () => {
  beforeEach(() => {
    // 每用例重置 store（避免用例间状态串扰）
    useRateLimitStore.setState({ visible: false, triggeredAt: 0 });
  });

  it('初始隐藏', () => {
    const state = useRateLimitStore.getState();
    expect(state.visible).toBe(false);
    expect(state.triggeredAt).toBe(0);
  });

  it('trigger 后可见并记录触发时间', () => {
    const before = Date.now();
    useRateLimitStore.getState().trigger();
    const state = useRateLimitStore.getState();
    expect(state.visible).toBe(true);
    expect(state.triggeredAt).toBeGreaterThanOrEqual(before);
  });

  it('dismiss 后隐藏并清空触发时间', () => {
    useRateLimitStore.getState().trigger();
    useRateLimitStore.getState().dismiss();
    const state = useRateLimitStore.getState();
    expect(state.visible).toBe(false);
    expect(state.triggeredAt).toBe(0);
  });

  it('自动过期判定：触发 5 分钟内未过期，超过后过期', () => {
    const now = 1_000_000;
    // 4 分钟前触发 → 未过期
    expect(isRateLimitExpired(now - 4 * 60 * 1000, now)).toBe(false);
    // 6 分钟前触发 → 已过期
    expect(isRateLimitExpired(now - 6 * 60 * 1000, now)).toBe(true);
    // 从未触发（0）→ 视为过期（不显示）
    expect(isRateLimitExpired(0, now)).toBe(true);
  });
});
