// use-session-compact.test.tsx
// 会话上下文压缩 mutation 单测：成功路径（本地消息态替换 + 缓存失效 + 结果 toast）
// 与失败路径（错误码本地化）

import type { ChatMessage } from '@code-agent/shared/renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_DETAIL_QUERY_KEY } from '@/hooks/use-sessions';
import { useSessionCompact } from './use-session-compact';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

/** window.api.session.compact mock 挂载点 */
function mockCompact(): ReturnType<typeof vi.fn> {
  const w = window as unknown as { api?: { session: { compact: ReturnType<typeof vi.fn> } } };
  w.api = { session: { compact: vi.fn() } };
  return w.api.session.compact;
}

/** 供断言的 IPC 响应包络（unwrap 消费 { data } | { error }） */
const ok = (payload: unknown): unknown => ({ data: payload });

/** QueryClientProvider wrapper 工厂（children 类型须为 ReactNode） */
function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }): ReactElement => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useSessionCompact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('成功：替换本地消息态 + 失效会话详情缓存 + 结果 toast', async () => {
    const compact = mockCompact();
    compact.mockResolvedValue(
      ok({
        messages: [{ role: 'user', content: 'hi' }] as ChatMessage[],
        reclaimedTokens: 42,
      }),
    );
    const qc = new QueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue(undefined);
    const setMessages = vi.fn();

    const { result } = renderHook(() => useSessionCompact({ chatId: 's1', setMessages }), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.compact();
    });
    await waitFor(() => {
      expect(setMessages).toHaveBeenCalledTimes(1);
    });

    expect(compact).toHaveBeenCalledWith({ sessionId: 's1' });
    // setMessages 收到重建后的 UIMessage[]（历史重建产物）
    const rebuilt = setMessages.mock.calls[0]?.[0] as Array<{ id: string; role: string }>;
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]).toMatchObject({ id: 'hist-0', role: 'user' });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: SESSION_DETAIL_QUERY_KEY('s1') });
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('压缩无可回收 token：info 提示（而非 success）', async () => {
    const compact = mockCompact();
    compact.mockResolvedValue(
      ok({ messages: [{ role: 'user', content: 'hi' }] as ChatMessage[], reclaimedTokens: 0 }),
    );
    const qc = new QueryClient();
    vi.spyOn(qc, 'invalidateQueries').mockResolvedValue(undefined);
    const setMessages = vi.fn();

    const { result } = renderHook(() => useSessionCompact({ chatId: 's1', setMessages }), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.compact();
    });
    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledTimes(1);
    });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('失败：[CODE] 错误走 unwrapErrorMessage 本地化（toast.error）', async () => {
    const compact = mockCompact();
    compact.mockResolvedValue({ error: { code: 'SESSION_NOT_FOUND', message: 'nope' } });
    const qc = new QueryClient();
    vi.spyOn(qc, 'invalidateQueries').mockResolvedValue(undefined);
    const setMessages = vi.fn();

    const { result } = renderHook(() => useSessionCompact({ chatId: 's1', setMessages }), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.compact();
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledTimes(1);
    });
    // setMessages 不被调用（压缩失败不替换本地消息态）
    expect(setMessages).not.toHaveBeenCalled();
  });
});
