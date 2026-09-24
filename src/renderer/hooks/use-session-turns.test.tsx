// src/renderer/hooks/use-session-turns.test.tsx
// use-session-turns 单元测试：回合列表 / 回合消息分页 / 页序平铺

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchTurnMessagesPage,
  flattenTurnPages,
  TURNS_PER_PAGE,
  useSessionTurns,
  useTurnMessagesInfinite,
} from './use-session-turns';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  function Wrapper({ children }: { readonly children: ReactNode }): ReactNode {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

const ok = <T,>(data: T) => ({ data });

/** 构造 n 个回合摘要（turnId: t0..tn-1） */
function makeTurns(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    turnId: `t${i}`,
    seq: i,
    modelId: 'm',
    status: 'completed' as const,
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    durationMs: 10,
    createdAt: i,
  }));
}

/** 回合 → 消息桩：t{i} 返回两条消息（user+assistant，序号内嵌） */
function stubTurnMessages(getTurnMessages: ReturnType<typeof vi.fn>): void {
  getTurnMessages.mockImplementation(async ({ turnId }: { turnId: string }) => {
    const i = Number(turnId.slice(1));
    return ok({
      messages: [
        { role: 'user', content: `u${i}` },
        { role: 'assistant', content: `a${i}` },
      ],
    });
  });
}

describe('use-session-turns hooks', () => {
  beforeEach(() => {
    window.api.session = {
      getTurns: vi.fn(),
      getTurnMessages: vi.fn(),
    } as never;
  });

  it('useSessionTurns：返回回合列表', async () => {
    (window.api.session.getTurns as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok({ sessionId: 's1', turns: makeTurns(2) }),
    );
    const { result } = renderHook(() => useSessionTurns('s1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data?.turns).toHaveLength(2));
    expect(window.api.session.getTurns).toHaveBeenCalledWith({ sessionId: 's1' });
  });

  it('useSessionTurns（null id）：不发起请求', async () => {
    const { result } = renderHook(() => useSessionTurns(null), { wrapper: createWrapper() });
    expect(result.current.isPending).toBe(true);
    expect(window.api.session.getTurns).not.toHaveBeenCalled();
  });

  it('useTurnMessagesInfinite：首页 = 最近 TURNS_PER_PAGE 个回合，消息按回合序平铺', async () => {
    stubTurnMessages(window.api.session.getTurnMessages as ReturnType<typeof vi.fn>);
    const turns = makeTurns(TURNS_PER_PAGE + 3);
    const { result } = renderHook(() => useTurnMessagesInfinite('s1', turns), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // 首页 = 最近 10 个回合（t3..t12）
    expect(result.current.data?.pages[0]?.turnCount).toBe(TURNS_PER_PAGE);
    expect(result.current.data?.pages[0]?.messages[0]?.content).toBe('u3');
    // 首页消息 = 10 回合 × 2 条
    expect(result.current.data?.pages[0]?.messages).toHaveLength(TURNS_PER_PAGE * 2);
    // 仍有更早回合
    expect(result.current.hasNextPage).toBe(true);
  });

  it('useTurnMessagesInfinite：全部回合 ≤ 一页时无更早页', async () => {
    stubTurnMessages(window.api.session.getTurnMessages as ReturnType<typeof vi.fn>);
    const { result } = renderHook(() => useTurnMessagesInfinite('s1', makeTurns(3)), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(false);
  });

  it('flattenTurnPages：页序反转（最早页在前），回合内顺序保持', async () => {
    stubTurnMessages(window.api.session.getTurnMessages as ReturnType<typeof vi.fn>);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    function LocalWrapper({ children }: { readonly children: ReactNode }): ReactNode {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const turns = makeTurns(TURNS_PER_PAGE + 3);
    const { result } = renderHook(
      () => {
        const query = useTurnMessagesInfinite('s1', turns);
        // v5 tracked-props：渲染期读取属性才会在其变更时通知（对齐 ChatPage 真实消费）
        void query.data;
        void query.hasNextPage;
        void query.isSuccess;
        return query;
      },
      {
        wrapper: LocalWrapper,
      },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // fetchNextPage 触发的状态更新需在 act 内落渲染（renderHook 观察者同步）
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    const flat = flattenTurnPages(result.current.data?.pages);
    // 13 回合 × 2 条
    expect(flat).toHaveLength(13 * 2);
    // 最早回合（t0）在最前，最后回合（t12）在最后
    expect(flat[0]?.content).toBe('u0');
    expect(flat.at(-1)?.content).toBe('a12');
  });

  it('fetchTurnMessagesPage：空回合窗返回空页', async () => {
    const page = await fetchTurnMessagesPage(makeTurns(2), 5);
    expect(page).toEqual({ turnCount: 0, messages: [] });
  });
});
