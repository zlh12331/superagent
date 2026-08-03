// src/renderer/hooks/__tests__/use-sessions.test.tsx
// use-sessions 单元测试：会话列表 / 详情 / 创建 / 删除 / 重命名

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useCreateSession,
  useDeleteSession,
  useRecentDirs,
  useRenameSession,
  useSessionDetail,
  useSessionsQuery,
} from '../use-sessions';

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

describe('use-sessions hooks', () => {
  beforeEach(() => {
    window.api.session = {
      list: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      rename: vi.fn(),
      create: vi.fn(),
      listRecentDirs: vi.fn(),
    } as never;
  });

  it('useSessionsQuery：成功返回会话列表', async () => {
    (window.api.session.list as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok({ sessions: [{ id: 's1', title: '会话1' }], total: 1 }),
    );
    const { result } = renderHook(() => useSessionsQuery(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data?.total).toBe(1));
    expect(window.api.session.list).toHaveBeenCalled();
  });

  it('useSessionDetail：按 id 获取会话详情', async () => {
    (window.api.session.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok({ session: { id: 's1', messages: [] } }),
    );
    const { result } = renderHook(() => useSessionDetail('s1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data?.session?.id).toBe('s1'));
    expect(window.api.session.get).toHaveBeenCalledWith({ id: 's1' });
  });

  it('useSessionDetail（null id）：不发起请求', async () => {
    const { result } = renderHook(() => useSessionDetail(null), { wrapper: createWrapper() });
    expect(result.current.isPending).toBe(true);
    expect(window.api.session.get).not.toHaveBeenCalled();
  });

  it('useCreateSession：调用 create 并返回 sessionId', async () => {
    (window.api.session.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok({ sessionId: 's-new' }),
    );
    const { result } = renderHook(() => useCreateSession(), { wrapper: createWrapper() });
    result.current.mutate({ workingDir: '/tmp', title: '新会话' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(window.api.session.create).toHaveBeenCalledWith({
      workingDir: '/tmp',
      title: '新会话',
    });
  });

  it('useDeleteSession：调用 delete', async () => {
    (window.api.session.delete as ReturnType<typeof vi.fn>).mockResolvedValue(ok({ ok: true }));
    const { result } = renderHook(() => useDeleteSession(), { wrapper: createWrapper() });
    // mutate 接收会话 id 字符串（非对象）
    result.current.mutate('s1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(window.api.session.delete).toHaveBeenCalledWith({ id: 's1' });
  });

  it('useRenameSession：调用 rename', async () => {
    (window.api.session.rename as ReturnType<typeof vi.fn>).mockResolvedValue(ok({ ok: true }));
    const { result } = renderHook(() => useRenameSession(), { wrapper: createWrapper() });
    result.current.mutate({ id: 's1', title: '改名' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(window.api.session.rename).toHaveBeenCalledWith({ id: 's1', title: '改名' });
  });

  it('useRecentDirs：返回最近目录', async () => {
    (window.api.session.listRecentDirs as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok({ dirs: [{ path: '/a', lastUsed: 1 }] }),
    );
    const { result } = renderHook(() => useRecentDirs(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data?.dirs).toHaveLength(1));
  });
});
