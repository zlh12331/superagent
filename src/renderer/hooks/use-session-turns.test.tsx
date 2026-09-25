// src/renderer/hooks/use-session-turns.test.tsx
// use-session-turns 单元测试：回合列表 / 回合消息分页 / 页序平铺 / 身份游标不变性

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

  it('useTurnMessagesInfinite：首页 = 最近 TURNS_PER_PAGE 个回合，按回合分组', async () => {
    stubTurnMessages(window.api.session.getTurnMessages as ReturnType<typeof vi.fn>);
    const turns = makeTurns(TURNS_PER_PAGE + 3);
    const { result } = renderHook(() => useTurnMessagesInfinite('s1', turns), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // 首页 = 最近 10 个回合（t3..t12）
    expect(result.current.data?.pages[0]?.turnCount).toBe(TURNS_PER_PAGE);
    expect(result.current.data?.pages[0]?.turns[0]?.turnId).toBe('t3');
    expect(result.current.data?.pages[0]?.turns[0]?.messages[0]?.content).toBe('u3');
    // 首页消息 = 10 回合 × 2 条
    const total = (result.current.data?.pages[0]?.turns ?? []).reduce(
      (sum, g) => sum + g.messages.length,
      0,
    );
    expect(total).toBe(TURNS_PER_PAGE * 2);
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

  it('useTurnMessagesInfinite：翻页按锚点回合身份递推，铺满全部回合后判尽', async () => {
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
    // 第一次翻页：锚点 = 首页首回合 t3 → 窗口 [0, 3)
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(result.current.data?.pages[1]?.turns.map((g) => g.turnId)).toEqual(['t0', 't1', 't2']);
    expect(result.current.hasNextPage).toBe(false);

    const flat = flattenTurnPages(result.current.data?.pages);
    // 13 回合 × 2 条，无重复
    expect(flat).toHaveLength(13 * 2);
    // 最早回合（t0）在最前，最后回合（t12）在最后
    expect(flat[0]?.content).toBe('u0');
    expect(flat.at(-1)?.content).toBe('a12');
  });

  it('fetchTurnMessagesPage：锚点不存在返回空页（翻页判尽终止）', async () => {
    const page = await fetchTurnMessagesPage(makeTurns(2), 'missing');
    expect(page).toEqual({ turnCount: 0, turns: [] });
  });

  it('fetchTurnMessagesPage：锚定窗口不含锚点回合（衔接上一页左端）', async () => {
    stubTurnMessages(window.api.session.getTurnMessages as ReturnType<typeof vi.fn>);
    const page = await fetchTurnMessagesPage(makeTurns(13), 't3');
    expect(page.turnCount).toBe(3);
    expect(page.turns.map((g) => g.turnId)).toEqual(['t0', 't1', 't2']);
  });

  it('身份游标不变性：回合列表增长后同锚点窗口不变（append-only 索引稳定）', async () => {
    stubTurnMessages(window.api.session.getTurnMessages as ReturnType<typeof vi.fn>);
    const before = await fetchTurnMessagesPage(makeTurns(13), 't3');
    // 模拟新回合落库：列表尾部追加 3 个回合（回合一经产生不消失）
    const grown = [
      ...makeTurns(13),
      ...makeTurns(3).map((t, i) => ({ ...t, turnId: `n${i}`, seq: 13 + i })),
    ];
    const after = await fetchTurnMessagesPage(grown, 't3');
    expect(after.turns.map((g) => g.turnId)).toEqual(before.turns.map((g) => g.turnId));
  });

  it('flattenTurnPages：页间回合重叠时按身份去重（保序首现）', () => {
    const msg = (content: string) => ({ role: 'user' as const, content });
    // 重叠回合（t2）在两页中内容一致——回合消息一经产生不可变，
    // 重叠只来自交错窗口内的布局混合，去重取首现即可
    const pages = [
      {
        turnCount: 2,
        turns: [
          { turnId: 't2', messages: [msg('u2')] },
          { turnId: 't3', messages: [msg('u3')] },
        ],
      },
      {
        turnCount: 2,
        turns: [
          { turnId: 't1', messages: [msg('u1')] },
          { turnId: 't2', messages: [msg('u2')] },
        ],
      },
    ];
    const flat = flattenTurnPages(pages);
    // 最早页在前：t1、t2、t3 各出现一次
    expect(flat.map((m) => m.content)).toEqual(['u1', 'u2', 'u3']);
  });
});
