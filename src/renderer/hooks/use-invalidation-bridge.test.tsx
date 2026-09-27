// src/renderer/hooks/use-invalidation-bridge.test.tsx
// use-invalidation-bridge 单测：订阅/退订 → 逐域前缀失效 + 覆盖登记
import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isTurnEndCovered, resetInvalidationCoverage } from '@/lib/invalidation/invalidation';
import { queryClient as globalQueryClient } from '@/lib/query/query-client';

import { useInvalidationBridge } from './use-invalidation-bridge';

/** 事件回调捕获（测试手动触发） */
let domainsCallback: ((payload: unknown) => void) | undefined;
let unsubscribed = false;

function createWrapper() {
  function Wrapper({ children }: { readonly children: ReactNode }): ReactNode {
    return <QueryClientProvider client={globalQueryClient}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

/** 构造回合结束聚合声明域（与主进程 turnEndInvalidationDomains 等形） */
function turnEndDomains(sessionId: string): string[] {
  return ['sessions', `session:${sessionId}`, 'goal', 'task', 'usage', 'git', 'file', 'turns'];
}

describe('use-invalidation-bridge', () => {
  beforeEach(() => {
    domainsCallback = undefined;
    unsubscribed = false;
    vi.clearAllMocks();
    resetInvalidationCoverage();
    globalQueryClient.clear();
    window.api.invalidation = {
      subscribeDomains: vi.fn((cb: (payload: unknown) => void) => {
        domainsCallback = cb;
        return () => {
          unsubscribed = true;
        };
      }),
    } as never;
  });

  it('挂载时订阅 invalidation:event:domains；卸载时退订', () => {
    const { unmount } = renderHook(() => useInvalidationBridge(), { wrapper: createWrapper() });
    expect(window.api.invalidation.subscribeDomains).toHaveBeenCalledOnce();

    unmount();
    expect(unsubscribed).toBe(true);
  });

  it('事件 → 按域映射逐域前缀失效', () => {
    const spy = vi
      .spyOn(globalQueryClient, 'invalidateQueries')
      .mockResolvedValue(undefined as never);
    renderHook(() => useInvalidationBridge(), { wrapper: createWrapper() });

    domainsCallback?.({ domains: ['sessions', 'session:s1', 'memory'], sessionId: 's1' });

    expect(spy).toHaveBeenCalledWith({ queryKey: ['sessions'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['session', 's1'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['memory'] });
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it('回合结束聚合事件 → 登记覆盖（use-agent-bridge 回落判定依据）', () => {
    const spy = vi
      .spyOn(globalQueryClient, 'invalidateQueries')
      .mockResolvedValue(undefined as never);
    renderHook(() => useInvalidationBridge(), { wrapper: createWrapper() });

    domainsCallback?.({ domains: turnEndDomains('s1'), sessionId: 's1' });

    // 登记生效（isTurnEndCovered 即 use-agent-bridge 引用的同一入口）
    expect(isTurnEndCovered('s1')).toBe(true);
    spy.mockRestore();
  });
});
