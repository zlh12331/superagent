// src/renderer/lib/invalidation/invalidation.test.ts
// 失效域纯函数层单测：域映射（与 QUERY_KEY_ROOTS 对齐）/ 前缀失效 / 回合结束覆盖登记
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IM_CHANNELS_QUERY_KEY, QUERY_KEY_ROOTS } from '@/lib/query/keys';
import { queryClient } from '@/lib/query/query-client';

import {
  applyDomainInvalidation,
  domainToQueryKey,
  isTurnEndCovered,
  noteInvalidationEvent,
  resetInvalidationCoverage,
} from './invalidation';

/** 构造回合结束聚合声明域（与主进程 turnEndInvalidationDomains 等形） */
function turnEndDomains(sessionId: string): string[] {
  return ['sessions', `session:${sessionId}`, 'goal', 'task', 'usage', 'git', 'file', 'turns'];
}

describe('domainToQueryKey（域映射）', () => {
  it('列表域 → QUERY_KEY_ROOTS 对应根', () => {
    expect(domainToQueryKey('sessions')).toEqual(QUERY_KEY_ROOTS.sessions);
    expect(domainToQueryKey('goal')).toEqual(QUERY_KEY_ROOTS.goal);
    expect(domainToQueryKey('task')).toEqual(QUERY_KEY_ROOTS.task);
    expect(domainToQueryKey('usage')).toEqual(QUERY_KEY_ROOTS.usage);
    expect(domainToQueryKey('git')).toEqual(QUERY_KEY_ROOTS.git);
    expect(domainToQueryKey('file')).toEqual(QUERY_KEY_ROOTS.file);
    expect(domainToQueryKey('turns')).toEqual(QUERY_KEY_ROOTS.turns);
    expect(domainToQueryKey('memory')).toEqual(QUERY_KEY_ROOTS.memory);
  });

  it("单会话域 'session:<id>' → ['session', id]（详情 + 回合历史前缀）", () => {
    expect(domainToQueryKey('session:abc-123')).toEqual(['session', 'abc-123']);
  });

  it("'im' 域不在 QUERY_KEY_ROOTS 内，仍按 key 首段命中 IM_CHANNELS_QUERY_KEY", () => {
    // keys.ts:18-19 既定设计：im 域无专用 hook、key 未纳入前缀根表；
    // 映射是纯 split 不查表，故 'im' 天然命中 ['im', 'channels']（keys.ts:68）
    expect(QUERY_KEY_ROOTS).not.toHaveProperty('im');
    expect(IM_CHANNELS_QUERY_KEY[0]).toBe('im');
    expect(domainToQueryKey('im')).toEqual(['im']);
  });

  it('非法形态返回 null（空串 / 空段）', () => {
    expect(domainToQueryKey('')).toBeNull();
    expect(domainToQueryKey('session:')).toBeNull();
    expect(domainToQueryKey(':')).toBeNull();
    expect(domainToQueryKey('a::b')).toBeNull();
  });
});

describe('applyDomainInvalidation（前缀失效）', () => {
  it('逐域 invalidateQueries；非法域跳过', () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined as never);

    applyDomainInvalidation(['sessions', 'session:s1', '']);

    expect(spy).toHaveBeenCalledWith({ queryKey: ['sessions'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['session', 's1'] });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe('回合结束覆盖登记（use-agent-bridge 回落判定）', () => {
  beforeEach(() => {
    resetInvalidationCoverage();
  });

  it('全域命中 → 登记覆盖', () => {
    noteInvalidationEvent(turnEndDomains('s1'), 's1');
    expect(isTurnEndCovered('s1')).toBe(true);
  });

  it('部分命中（缺任一全局域）不登记——单会话写路径不得冒充聚合声明', () => {
    noteInvalidationEvent(['sessions', 'session:s1'], 's1');
    expect(isTurnEndCovered('s1')).toBe(false);
    noteInvalidationEvent(['sessions', 'session:s1', 'goal', 'task', 'usage', 'git', 'file'], 's1');
    expect(isTurnEndCovered('s1')).toBe(false);
  });

  it('域不含本会话的 session:<id> 不登记（session:other 不算）', () => {
    noteInvalidationEvent(turnEndDomains('other'), 's1');
    expect(isTurnEndCovered('s1')).toBe(false);
  });

  it('sessionId 缺省不登记；未登记会话返回 false', () => {
    noteInvalidationEvent(turnEndDomains('s1'));
    expect(isTurnEndCovered('s1')).toBe(false);
    expect(isTurnEndCovered('unknown')).toBe(false);
    expect(isTurnEndCovered('')).toBe(false);
  });

  it('TTL 过期后视为未覆盖（防陈旧误判）', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-28T00:00:00Z'));
      noteInvalidationEvent(turnEndDomains('s1'), 's1');
      expect(isTurnEndCovered('s1')).toBe(true);

      vi.setSystemTime(new Date('2026-09-28T00:00:31Z'));
      expect(isTurnEndCovered('s1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('容量上界：超限逐出最旧（防泄漏）', () => {
    for (let i = 0; i < 130; i++) {
      noteInvalidationEvent(turnEndDomains(`s${i}`), `s${i}`);
    }
    // 最旧的 s0/s1 被逐出，最新登记仍有效
    expect(isTurnEndCovered('s0')).toBe(false);
    expect(isTurnEndCovered('s1')).toBe(false);
    expect(isTurnEndCovered('s129')).toBe(true);
  });
});
