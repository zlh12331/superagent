// src/renderer/hooks/use-system.test.ts
// use-system 单元测试：useLogsReadQuery 的 keepPreviousData 接线（补测）
// ──────────────────────────────────────────────────────────────
// 参照 LogsPanel.test.tsx「占位数据」用例的断言形态，但不 mock hook 本身：
// renderHook 真调 useLogsReadQuery，只替换 window.api.logs.read——
// 用手动 resolve 的 deferred 精确制造「新 key 已发起、新响应未回」的窗口期，
// 断言级别/行数切换时旧切片驻留（data 不丢）+ isPlaceholderData true→false 翻转。
// ──────────────────────────────────────────────────────────────

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LOGS_READ_QUERY_KEY, useLogsReadQuery } from './use-system';

/** IPC 响应 envelope（unwrap 消费形状，与 use-sessions.test 的 ok 助手同构） */
const ok = <T>(data: T) => ({ data });

/** 手动控制的 deferred（测试精确控制响应时序） */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 日志切片工厂 */
function logsRes(lines: string[]) {
  return { lines, total: lines.length, filePath: '/tmp/main.log', truncated: false };
}

describe('use-system · useLogsReadQuery keepPreviousData', () => {
  beforeEach(() => {
    window.api.logs = { read: vi.fn() } as never;
  });

  it('首次加载后切换 level/lines：旧数据驻留 + isPlaceholderData true→false', async () => {
    // 两张 deferred 对应两个 key：first=(200, undefined)，second=(200, 'error')
    const first = createDeferred<ReturnType<typeof ok>>();
    const second = createDeferred<ReturnType<typeof ok>>();
    const read = window.api.logs.read as unknown as ReturnType<typeof vi.fn>;
    read.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    function Wrapper({ children }: { readonly children: ReactNode }): ReactNode {
      return createElement(QueryClientProvider, { client: queryClient }, children);
    }

    // 1. 首次加载（lines=200，无 level）：无占位数据，isPlaceholderData=false
    //    initialProps 断言为 LogsProps：renderHook 的 TProps 字面量收窄自
    //    initialProps，不断言则 level 被推成 undefined 字面量，rerender 报错
    type LogsProps = { lines: number; level: 'error' | undefined };
    const view = renderHook((props: LogsProps) => useLogsReadQuery(props.lines, props.level), {
      initialProps: { lines: 200, level: undefined } as LogsProps,
      wrapper: Wrapper,
    });
    expect(view.result.current.data).toBeUndefined();
    expect(view.result.current.isPlaceholderData).toBe(false);

    first.resolve(ok(logsRes(['a'])));
    await waitFor(() => expect(view.result.current.data?.lines).toEqual(['a']));
    expect(view.result.current.isPlaceholderData).toBe(false);

    // 2. 切换 level='error'（等价场景：切换 lines）：新 key 发起、响应未回——
    //    keepPreviousData 让旧切片驻留为占位（isPlaceholderData=true，消费方降透明过渡）
    view.rerender({ lines: 200, level: 'error' });
    await waitFor(() => expect(view.result.current.isPlaceholderData).toBe(true));
    expect(view.result.current.data?.lines).toEqual(['a']);
    expect(read).toHaveBeenLastCalledWith({ lines: 200, level: 'error' });

    // 3. 新切片到达：占位翻转为真数据，新旧 key 各持独立缓存条目
    second.resolve(ok(logsRes(['b'])));
    await waitFor(() => expect(view.result.current.data?.lines).toEqual(['b']));
    expect(view.result.current.isPlaceholderData).toBe(false);
    expect(queryClient.getQueryData(LOGS_READ_QUERY_KEY(200, undefined))).toMatchObject({
      lines: ['a'],
    });
    expect(queryClient.getQueryData(LOGS_READ_QUERY_KEY(200, 'error'))).toMatchObject({
      lines: ['b'],
    });
  });

  it('首次加载不受 keepPreviousData 影响：首份新数据到达时 isPlaceholderData=false', async () => {
    const first = createDeferred<ReturnType<typeof ok>>();
    (window.api.logs.read as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => first.promise,
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    function Wrapper({ children }: { readonly children: ReactNode }): ReactNode {
      return createElement(QueryClientProvider, { client: queryClient }, children);
    }

    const view = renderHook(() => useLogsReadQuery(200, undefined, true), {
      wrapper: Wrapper,
    });
    expect(view.result.current.isPlaceholderData).toBe(false);

    first.resolve(ok(logsRes(['x'])));
    await waitFor(() => expect(view.result.current.data?.lines).toEqual(['x']));
    expect(view.result.current.isPlaceholderData).toBe(false);
  });
});
