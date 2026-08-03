// src/renderer/stores/transient/__tests__/usage-store.test.ts
// usage-store 单测：per-session token 用量累积
import { beforeEach, describe, expect, it } from 'vitest';

import { EMPTY_USAGE, useUsageStore } from '../usage-store';

describe('usage-store', () => {
  beforeEach(() => {
    useUsageStore.getState().clearBySession('s1');
    useUsageStore.getState().clearBySession('s2');
  });

  it('初始为空（get 返回 EMPTY_USAGE）', () => {
    expect(useUsageStore.getState().usageBySession.get('s1') ?? EMPTY_USAGE).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });

  it('addUsage：累积一次回合用量', () => {
    useUsageStore
      .getState()
      .addUsage('s1', { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    const usage = useUsageStore.getState().usageBySession.get('s1');
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  });

  it('addUsage：同会话多次回合累加（per-session 累积）', () => {
    useUsageStore
      .getState()
      .addUsage('s1', { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    useUsageStore
      .getState()
      .addUsage('s1', { inputTokens: 200, outputTokens: 100, totalTokens: 300 });
    const usage = useUsageStore.getState().usageBySession.get('s1');
    expect(usage).toEqual({ inputTokens: 300, outputTokens: 150, totalTokens: 450 });
  });

  it('addUsage：不同会话互不干扰（per-session 隔离）', () => {
    useUsageStore.getState().addUsage('s1', { totalTokens: 100 });
    useUsageStore.getState().addUsage('s2', { totalTokens: 200 });
    expect(useUsageStore.getState().usageBySession.get('s1')?.totalTokens).toBe(100);
    expect(useUsageStore.getState().usageBySession.get('s2')?.totalTokens).toBe(200);
  });

  it('addUsage：缺省字段视为 0', () => {
    useUsageStore.getState().addUsage('s1', { totalTokens: 150 });
    const usage = useUsageStore.getState().usageBySession.get('s1');
    expect(usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 150 });
  });

  it('clearBySession：清空指定会话用量', () => {
    useUsageStore.getState().addUsage('s1', { totalTokens: 100 });
    useUsageStore.getState().addUsage('s2', { totalTokens: 200 });
    useUsageStore.getState().clearBySession('s1');
    expect(useUsageStore.getState().usageBySession.has('s1')).toBe(false);
    expect(useUsageStore.getState().usageBySession.get('s2')?.totalTokens).toBe(200);
  });
});
