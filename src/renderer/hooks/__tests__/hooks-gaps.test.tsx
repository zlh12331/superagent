// src/renderer/hooks/__tests__/hooks-gaps.test.ts
// hooks 层批次2 缺口补全：tool-bridge 事件桥接、conversation-search 边界、
// api-key 查询与 mutation、sessions 查询与乐观更新
//
// 测试要点（真实 hook + window.api 按用例注入；QueryClient wrapper）：
// 1. useToolBridge：事件订阅 → store 写入 / terminal 副作用 / 卸载清理
// 2. findMessageMatches：大小写/空查询/无匹配/多匹配
// 3. useApiKey：查询成功/守卫/mutation 成功失败
// 4. useSessions：list/get 成功错误/delete rename 乐观更新与回滚/create/pin

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '@/stores/transient/terminal-store';
import { useToolStore } from '@/stores/transient/tool-store';
import { useSetApiKey } from '../use-api-key';
import { findMessageMatches, useConversationSearch } from '../use-conversation-search';
import {
  useCreateSession,
  useDeleteSession,
  usePinSession,
  useRecentDirs,
  useRenameSession,
  useSessionDetail,
  useSessionsQuery,
} from '../use-sessions';
import { useToolBridge } from '../use-tool-bridge';

// sonner toast 外部依赖 mock（业务逻辑真实）
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, queryClient };
}

/** 注入 window.api 域方法（setup.ts afterEach 会重置为空骨架） */
function injectApi(domain: string, methods: Record<string, unknown>): void {
  (window.api as unknown as Record<string, Record<string, unknown>>)[domain] = methods;
}

/** 构造 UIMessage 形状（最小字段） */
function makeMessage(id: string, text: string): Parameters<typeof findMessageMatches>[0][number] {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
  } as never;
}

describe('hooks 批次2 缺口补全', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useToolStore.setState({ callsBySession: new Map() });
  });

  describe('use-tool-bridge', () => {
    it('window.api 未注入：不订阅不抛（浏览器模式守卫）', () => {
      Object.defineProperty(window, 'api', {
        value: undefined,
        writable: true,
        configurable: true,
      });
      expect(() => renderHook(() => useToolBridge())).not.toThrow();
    });

    it('tool:call 事件：写入 tool-store（pending 项）', () => {
      const unsubscribe = vi.fn();
      const subscribeToolCall = vi.fn((_p: unknown) => unsubscribe);
      injectApi('agent', {
        subscribeToolCall,
        subscribeToolResult: vi.fn((_p: unknown) => vi.fn()),
      });

      renderHook(() => useToolBridge());

      const callback = subscribeToolCall.mock.calls[0]?.[0] as (p: unknown) => void;
      expect(callback).toBeDefined();
      act(() => {
        callback({
          sessionId: 'sess-a',
          toolCallId: 'call-1',
          toolName: 'grep',
          input: { pattern: 'x' },
          permission: 'auto',
        });
      });
      const calls = useToolStore.getState().callsBySession.get('sess-a') ?? [];
      expect(calls[0]).toMatchObject({ id: 'call-1', toolName: 'grep', status: 'pending' });
    });

    it('tool:result 事件：更新为 success（含 title）', () => {
      const subscribeToolResult = vi.fn((_p: unknown) => vi.fn());
      injectApi('agent', {
        subscribeToolCall: vi.fn((_p: unknown) => vi.fn()),
        subscribeToolResult,
      });

      useToolStore.getState().appendToolCall({
        id: 'call-2',
        sessionId: 'sess-a',
        toolName: 'read_file',
        input: {},
        permission: 'auto',
      });
      renderHook(() => useToolBridge());

      const callback = subscribeToolResult.mock.calls[0]?.[0] as (p: unknown) => void;
      act(() => {
        callback({
          sessionId: 'sess-a',
          toolCallId: 'call-2',
          toolName: 'read_file',
          output: '内容',
          error: undefined,
          title: '读取完成',
        });
      });
      const call = useToolStore.getState().callsBySession.get('sess-a')?.[0];
      expect(call?.status).toBe('success');
      expect(call?.output).toBe('内容');
      expect(call?.title).toBe('读取完成');
    });

    it('terminal 工具 metadata action=create：同步创建终端', () => {
      const subscribeToolResult = vi.fn((_p: unknown) => vi.fn());
      injectApi('agent', {
        subscribeToolCall: vi.fn((_p: unknown) => vi.fn()),
        subscribeToolResult,
      });

      renderHook(() => useToolBridge());
      const callback = subscribeToolResult.mock.calls[0]?.[0] as (p: unknown) => void;
      act(() => {
        callback({
          sessionId: 'sess-t',
          toolCallId: 'c-t1',
          toolName: 'terminal',
          output: null,
          error: undefined,
          metadata: {
            action: 'create',
            terminalId: 'term-1',
            title: '构建',
            pid: 123,
            cwd: '/tmp',
          },
        });
      });
      const terminals = useTerminalStore.getState().terminals;
      expect(terminals).toContainEqual(
        expect.objectContaining({ id: 'term-1', sessionId: 'sess-t', title: '构建', alive: true }),
      );
    });

    it('terminal 已存在：不重复创建', () => {
      const subscribeToolResult = vi.fn((_p: unknown) => vi.fn());
      injectApi('agent', {
        subscribeToolCall: vi.fn((_p: unknown) => vi.fn()),
        subscribeToolResult,
      });

      useTerminalStore.getState().createTerminal({
        id: 'term-2',
        sessionId: 'sess-t',
        title: '已有',
        pid: null,
        cwd: '',
        alive: true,
      });
      const before = useTerminalStore.getState().terminals.length;

      renderHook(() => useToolBridge());
      const callback = subscribeToolResult.mock.calls[0]?.[0] as (p: unknown) => void;
      act(() => {
        callback({
          sessionId: 'sess-t',
          toolCallId: 'c-t2',
          toolName: 'terminal',
          output: null,
          error: undefined,
          metadata: { action: 'create', terminalId: 'term-2' },
        });
      });
      expect(useTerminalStore.getState().terminals).toHaveLength(before);
    });

    it('卸载：取消两个订阅', () => {
      const unsubscribeCall = vi.fn();
      const unsubscribeResult = vi.fn();
      injectApi('agent', {
        subscribeToolCall: vi.fn((_p: unknown) => unsubscribeCall),
        subscribeToolResult: vi.fn((_p: unknown) => unsubscribeResult),
      });

      const { unmount } = renderHook(() => useToolBridge());
      unmount();
      expect(unsubscribeCall).toHaveBeenCalled();
      expect(unsubscribeResult).toHaveBeenCalled();
    });
  });

  describe('use-conversation-search', () => {
    it('findMessageMatches：大小写不敏感 + 多匹配顺序', () => {
      const messages = [
        makeMessage('1', 'Hello World'),
        makeMessage('2', 'hello again'),
        makeMessage('3', '其他'),
      ];
      expect(findMessageMatches(messages, 'HELLO')).toEqual([0, 1]);
    });

    it('findMessageMatches：空查询/纯空白 → 空', () => {
      const messages = [makeMessage('1', 'hello')];
      expect(findMessageMatches(messages, '')).toEqual([]);
      expect(findMessageMatches(messages, '   ')).toEqual([]);
    });

    it('findMessageMatches：无匹配 → 空', () => {
      const messages = [makeMessage('1', 'hello')];
      expect(findMessageMatches(messages, '不存在')).toEqual([]);
    });

    it('navigate：循环导航（下一个/上一个/无匹配不导航）', () => {
      const messages = [
        makeMessage('1', 'foo a'),
        makeMessage('2', 'foo b'),
        makeMessage('3', 'foo c'),
      ];
      const { result } = renderHook(() => useConversationSearch(messages));

      act(() => result.current.actions.open());
      act(() => result.current.actions.search('foo'));
      expect(result.current.matchIndexes).toEqual([0, 1, 2]);
      expect(result.current.currentMatch).toBe(0);

      act(() => result.current.actions.navigate(1));
      expect(result.current.currentMatch).toBe(1);
      act(() => result.current.actions.navigate(1));
      expect(result.current.currentMatch).toBe(2);
      // 循环：下一个回到 0
      act(() => result.current.actions.navigate(1));
      expect(result.current.currentMatch).toBe(0);
      // 上一个：从 0 回到 2
      act(() => result.current.actions.navigate(-1));
      expect(result.current.currentMatch).toBe(2);
    });

    it('search 空查询：currentMatch 重置为 -1', () => {
      const messages = [makeMessage('1', 'foo')];
      const { result } = renderHook(() => useConversationSearch(messages));
      act(() => result.current.actions.search('foo'));
      expect(result.current.currentMatch).toBe(0);
      act(() => result.current.actions.search(''));
      expect(result.current.currentMatch).toBe(-1);
      expect(result.current.matchIndexes).toEqual([]);
    });

    it('open/close：可见性与状态重置', () => {
      const messages = [makeMessage('1', 'foo')];
      const { result } = renderHook(() => useConversationSearch(messages));
      expect(result.current.visible).toBe(false);
      act(() => result.current.actions.open());
      expect(result.current.visible).toBe(true);
      act(() => result.current.actions.close());
      expect(result.current.visible).toBe(false);
      expect(result.current.query).toBe('');
    });

    it('navigate 无匹配：不导航（currentMatch 保持不变）', () => {
      const messages = [makeMessage('1', 'foo')];
      const { result } = renderHook(() => useConversationSearch(messages));
      act(() => result.current.actions.search('不存在的词'));
      expect(result.current.matchIndexes).toEqual([]);
      // search 非空查询时 currentMatch=0；无匹配时 navigate 直接返回（保持 0）
      act(() => result.current.actions.navigate(1));
      act(() => result.current.actions.navigate(-1));
      expect(result.current.currentMatch).toBe(0);
    });

    it('navigate：循环数学（0→1→0→1）', () => {
      const messages = [makeMessage('1', 'foo a'), makeMessage('2', 'foo b')];
      const { result } = renderHook(() => useConversationSearch(messages));
      act(() => result.current.actions.open());
      act(() => result.current.actions.search('foo'));
      expect(result.current.matchIndexes).toEqual([0, 1]);
      act(() => result.current.actions.navigate(1));
      expect(result.current.currentMatch).toBe(1);
      act(() => result.current.actions.navigate(1));
      expect(result.current.currentMatch).toBe(0);
      act(() => result.current.actions.navigate(1));
      expect(result.current.currentMatch).toBe(1);
    });
  });

  describe('use-api-key', () => {
    it('useSetApiKey 成功：调用 IPC 并返回 ok', async () => {
      const setApiKey = vi.fn(async () => ({ data: { ok: true } }));
      injectApi('settings', { setApiKey });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useSetApiKey(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync({ provider: 'deepseek', apiKey: 'sk-new' });
      });
      expect(setApiKey).toHaveBeenCalledWith({ provider: 'deepseek', apiKey: 'sk-new' });
    });

    it('useSetApiKey 失败：toast.error 提示', async () => {
      injectApi('settings', {
        setApiKey: vi.fn(async () => ({
          error: { code: 'INTERNAL_ERROR', message: '保存失败' },
        })),
      });
      const { toast } = await import('sonner');
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useSetApiKey(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync({ provider: 'deepseek', apiKey: 'x' }).catch(() => {});
      });
      expect(toast.error).toHaveBeenCalled();
    });
  });

  describe('use-sessions', () => {
    it('useSessionsQuery 成功：返回会话列表', async () => {
      injectApi('session', {
        list: vi.fn(async () => ({ data: { sessions: [{ id: 's1', title: '会话' }], total: 1 } })),
      });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useSessionsQuery(), { wrapper });
      // P3：无限分页——断言 pages 结构
      await waitFor(() =>
        expect(result.current.data?.pages[0]?.sessions).toEqual([{ id: 's1', title: '会话' }]),
      );
    });

    it('useSessionsQuery window.api 未注入：返回空列表', async () => {
      Object.defineProperty(window, 'api', {
        value: undefined,
        writable: true,
        configurable: true,
      });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useSessionsQuery(), { wrapper });
      // P3：无限分页——空列表为 pages 结构
      await waitFor(() => expect(result.current.data?.pages).toEqual([{ sessions: [], total: 0 }]));
    });

    it('useSessionsQuery 错误：抛出错误', async () => {
      injectApi('session', {
        list: vi.fn(async () => ({ error: { code: 'DB_ERROR', message: 'db down' } })),
      });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useSessionsQuery(), { wrapper });
      await waitFor(() => expect(result.current.isError).toBe(true));
    });

    it('useSessionDetail id=null：不执行查询（enabled false）', () => {
      const get = vi.fn();
      injectApi('session', { get });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useSessionDetail(null), { wrapper });
      expect(result.current.isPending).toBe(true);
      expect(get).not.toHaveBeenCalled();
    });

    it('useDeleteSession 成功：调用 IPC 并 resolve', async () => {
      const deleteApi = vi.fn(async () => ({ data: { ok: true } }));
      injectApi('session', { delete: deleteApi });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useDeleteSession(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync('s1');
      });
      expect(deleteApi).toHaveBeenCalledWith({ id: 's1' });
    });

    it('useDeleteSession 失败：toast.error 提示', async () => {
      injectApi('session', {
        delete: vi.fn(async () => ({ error: { code: 'DB_ERROR', message: '删除失败' } })),
      });
      const { toast } = await import('sonner');
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useDeleteSession(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync('s1').catch(() => {});
      });
      expect(toast.error).toHaveBeenCalled();
    });

    it('useRenameSession 成功：调用 IPC 并 resolve', async () => {
      const rename = vi.fn(async () => ({ data: { ok: true } }));
      injectApi('session', { rename });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useRenameSession(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync({ id: 's1', title: '新标题' });
      });
      expect(rename).toHaveBeenCalledWith({ id: 's1', title: '新标题' });
    });

    it('useCreateSession 成功：调用 IPC', async () => {
      const create = vi.fn(async () => ({ data: { sessionId: 's-new' } }));
      injectApi('session', { create });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useCreateSession(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync({ workingDir: '/tmp' });
      });
      expect(create).toHaveBeenCalledWith({ workingDir: '/tmp' });
    });

    it('usePinSession 成功：调用 IPC', async () => {
      const pin = vi.fn(async () => ({ data: { ok: true } }));
      injectApi('session', { pin });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => usePinSession(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync({ id: 's1', pinned: true });
      });
      expect(pin).toHaveBeenCalledWith({ id: 's1', pinned: true });
    });

    it('usePinSession 失败：mutate reject（无 onError，仅 invalidate）', async () => {
      injectApi('session', {
        pin: vi.fn(async () => ({ error: { code: 'DB_ERROR', message: '置顶失败' } })),
      });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => usePinSession(), { wrapper });
      await act(async () => {
        await expect(result.current.mutateAsync({ id: 's1', pinned: true })).rejects.toThrow(
          '置顶失败',
        );
      });
    });

    it('useCreateSession 失败：toast.error 提示', async () => {
      injectApi('session', {
        create: vi.fn(async () => ({ error: { code: 'DB_ERROR', message: '创建失败' } })),
      });
      const { toast } = await import('sonner');
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useCreateSession(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync({ workingDir: '/tmp' }).catch(() => {});
      });
      expect(toast.error).toHaveBeenCalled();
    });

    it('useSessionDetail 成功：返回会话详情', async () => {
      injectApi('session', {
        get: vi.fn(async () => ({ data: { id: 's1', title: '会话' } })),
      });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useSessionDetail('s1'), { wrapper });
      await waitFor(() => expect(result.current.data).toEqual({ id: 's1', title: '会话' }));
    });

    it('useSessionDetail 错误：抛出错误', async () => {
      injectApi('session', {
        get: vi.fn(async () => ({ error: { code: 'DB_ERROR', message: '读取失败' } })),
      });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useSessionDetail('s1'), { wrapper });
      await waitFor(() => expect(result.current.isError).toBe(true));
    });

    it('useSessionsQuery 异常响应（无 data 无 error）：抛出错误', async () => {
      injectApi('session', {
        list: vi.fn(async () => ({}) as never),
      });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useSessionsQuery(), { wrapper });
      await waitFor(() => expect(result.current.isError).toBe(true));
    });

    it('useRecentDirs 成功：返回目录列表', async () => {
      injectApi('session', {
        listRecentDirs: vi.fn(async () => ({ data: { dirs: ['/a', '/b'] } })),
      });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useRecentDirs(), { wrapper });
      await waitFor(() => expect(result.current.data?.dirs).toEqual(['/a', '/b']));
    });

    it('useRecentDirs window.api 未注入：返回空目录', async () => {
      Object.defineProperty(window, 'api', {
        value: undefined,
        writable: true,
        configurable: true,
      });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useRecentDirs(), { wrapper });
      await waitFor(() => expect(result.current.data).toEqual({ dirs: [] }));
    });

    it('useDeleteSession 失败：乐观更新回滚 + toast', async () => {
      injectApi('session', {
        delete: vi.fn(async () => ({ error: { code: 'DB_ERROR', message: '删除失败' } })),
      });
      const { wrapper, queryClient } = createWrapper();
      const prev = {
        sessions: [
          { id: 's1', title: 'a' },
          { id: 's2', title: 'b' },
        ],
        total: 2,
      };
      queryClient.setQueryData(['sessions'], prev);
      const { result } = renderHook(() => useDeleteSession(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync('s1').catch(() => {});
      });
      // onError 回滚：乐观移除的 s1 恢复（invalidate refetch 前快照）
      const cached = queryClient.getQueryData<{ sessions: { id: string }[] }>(['sessions']);
      expect(cached?.sessions.map((s) => s.id).sort()).toEqual(['s1', 's2']);
    });

    it('useRenameSession 失败：toast.error 提示', async () => {
      injectApi('session', {
        rename: vi.fn(async () => ({ error: { code: 'DB_ERROR', message: '重命名失败' } })),
      });
      const { toast } = await import('sonner');
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useRenameSession(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync({ id: 's1', title: '新' }).catch(() => {});
      });
      expect(toast.error).toHaveBeenCalled();
    });
  });
});
