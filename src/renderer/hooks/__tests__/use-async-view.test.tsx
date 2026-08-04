// src/renderer/hooks/__tests__/use-async-view.test.tsx
// useAsyncView 契约层单测：五态映射（loading / refreshing / error / empty / ready）
// 无业务 mock：用真实 QueryClient + useQuery 驱动各状态。

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { type AsyncView, useAsyncView } from '../use-async-view';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  function Wrapper({ children }: { readonly children: ReactNode }): ReactNode {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

/** 组合测试 hook：useQuery + useAsyncView，同时暴露 refetch 以驱动 refreshing */
function useTestHook(queryFn: () => Promise<string[]>): {
  view: AsyncView<string[]>;
  refetch: () => void;
} {
  const query = useQuery({ queryKey: ['async-view-test'], queryFn });
  const view = useAsyncView(query, { isEmpty: (d) => d.length === 0 });
  return { view, refetch: () => void query.refetch() };
}

/** 永不 resolve 的 promise（维持 pending） */
function pending(): Promise<string[]> {
  return new Promise(() => {});
}

describe('useAsyncView', () => {
  it('loading：首次加载无数据 → loading', () => {
    const { result } = renderHook(() => useTestHook(pending), { wrapper: createWrapper() });
    expect(result.current.view.state).toBe('loading');
  });

  it('ready：成功且非空 → ready 携带 data', async () => {
    const { result } = renderHook(() => useTestHook(async () => ['a', 'b']), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.view.state).toBe('ready'));
    expect(result.current.view).toEqual({ state: 'ready', data: ['a', 'b'] });
  });

  it('empty：成功但 isEmpty 为真 → empty', async () => {
    const { result } = renderHook(() => useTestHook(async () => []), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.view.state).toBe('empty'));
  });

  it('error：加载失败 → error 携带 retry', async () => {
    const { result } = renderHook(
      () =>
        useTestHook(async () => {
          throw new Error('[INTERNAL_ERROR] boom');
        }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.view.state).toBe('error'));
    const view = result.current.view;
    expect(view.state).toBe('error');
    if (view.state === 'error') {
      expect(view.error.message).toBe('[INTERNAL_ERROR] boom');
      expect(typeof view.retry).toBe('function');
      expect(view.data).toBeUndefined();
    }
  });

  it('refreshing：已有数据后台刷新 → refreshing 保留旧数据', async () => {
    let call = 0;
    const queryFn = async (): Promise<string[]> => {
      call += 1;
      if (call === 1) return ['a'];
      return pending(); // 第二次刷新挂起，维持 fetching
    };
    const { result } = renderHook(() => useTestHook(queryFn), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.view.state).toBe('ready'));

    result.current.refetch();
    await waitFor(() => expect(result.current.view.state).toBe('refreshing'));
    const view = result.current.view;
    if (view.state === 'refreshing') {
      expect(view.data).toEqual(['a']);
    }
  });
});
