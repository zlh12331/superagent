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

    view.rerender({ lines: 200, level: 'error' });
    await waitFor(() => expect(view.result.current.isPlaceholderData).toBe(true));
    expect(view.result.current.data?.lines).toEqual(['a']);
    expect(read).toHaveBeenLastCalledWith({ lines: 200, level: 'error' });

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
