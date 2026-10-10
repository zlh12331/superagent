import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSIONS_QUERY_KEY } from '@/hooks/use-sessions';
import {
  isTurnEndCovered,
  noteInvalidationEvent,
  resetInvalidationCoverage,
} from '@/lib/invalidation/invalidation';
import { queryClient as globalQueryClient } from '@/lib/query/query-client';
import { useAgentAskStore } from '@/stores/transient/agent-ask-store';
import { useApprovalsStore } from '@/stores/transient/approvals-store';
import { useToolStore } from '@/stores/transient/tool-store';
import { useTurnErrorStore } from '@/stores/transient/turn-error-store';

import { useAgentBridge } from './use-agent-bridge';

/** 事件回调捕获（测试手动触发） */
let startCallback: ((payload: unknown) => void) | undefined;
let endCallback: ((payload: unknown) => void) | undefined;
let errorCallback: ((payload: unknown) => void) | undefined;

function createWrapper() {
  function Wrapper({ children }: { readonly children: ReactNode }): ReactNode {
    return <QueryClientProvider client={globalQueryClient}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

/** 触发 stream:start 事件（模拟主进程推送） */
function fireStart(payload: unknown): void {
  startCallback?.(payload);
}

/** 触发 stream:end 事件（模拟主进程推送） */
function fireEnd(payload: unknown): void {
  endCallback?.(payload);
}

/** 触发 stream:error 事件 */
function fireError(payload: unknown): void {
  errorCallback?.(payload);
}

describe('use-agent-bridge', () => {
  beforeEach(() => {
    startCallback = undefined;
    endCallback = undefined;
    errorCallback = undefined;
    vi.clearAllMocks();
    useToolStore.getState().clearBySession('s1');
    useApprovalsStore.getState().clearBySession('s1');
    useAgentAskStore.getState().clearAsk();
    useTurnErrorStore.setState({ errors: {} });
    globalQueryClient.clear();
    resetInvalidationCoverage();

    window.api.agent = {
      run: vi.fn(),
      stop: vi.fn(),
      approvalResponse: vi.fn(),
      subscribeStreamPart: vi.fn(() => () => {}),
      subscribeStreamStart: vi.fn((cb: (payload: unknown) => void) => {
        startCallback = cb;
        return () => {};
      }),
      subscribeStreamEnd: vi.fn((cb: (payload: unknown) => void) => {
        endCallback = cb;
        return () => {};
      }),
      subscribeStreamError: vi.fn((cb: (payload: unknown) => void) => {
        errorCallback = cb;
        return () => {};
      }),
      subscribeToolCall: vi.fn(() => () => {}),
      subscribeToolResult: vi.fn(() => () => {}),
      subscribeApprovalRequest: vi.fn(() => () => {}),
    } as never;
  });

  it('挂载时订阅 stream:start / stream:end / stream:error', () => {
    renderHook(() => useAgentBridge(), { wrapper: createWrapper() });
    expect(window.api.agent.subscribeStreamStart).toHaveBeenCalledOnce();
    expect(window.api.agent.subscribeStreamEnd).toHaveBeenCalledOnce();
    expect(window.api.agent.subscribeStreamError).toHaveBeenCalledOnce();
  });

  it('stream:start（D4A）：setQueryData 把该会话乐观点亮为 running，不触发 invalidate', () => {
    globalQueryClient.setQueryData(SESSIONS_QUERY_KEY, {
      pages: [{ sessions: [{ id: 's1', title: '会话1', lastRunStatus: 'idle' }], total: 1 }],
      pageParams: [0],
    });
    const invalidateSpy = vi.spyOn(globalQueryClient, 'invalidateQueries');
    renderHook(() => useAgentBridge(), { wrapper: createWrapper() });

    fireStart({ sessionId: 's1' });

    const data = globalQueryClient.getQueryData<{
      pages: Array<{ sessions: Array<{ id: string; lastRunStatus: string }> }>;
    }>(SESSIONS_QUERY_KEY);
    expect(data?.pages[0]?.sessions[0]?.lastRunStatus).toBe('running');
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('stream:start（D4A）：会话不在缓存（新会话首回合）时静默无操作', () => {
    globalQueryClient.setQueryData(SESSIONS_QUERY_KEY, {
      pages: [{ sessions: [{ id: 'other', title: '其他会话', lastRunStatus: 'idle' }], total: 1 }],
      pageParams: [0],
    });
    renderHook(() => useAgentBridge(), { wrapper: createWrapper() });

    fireStart({ sessionId: 's-new' });

    const data = globalQueryClient.getQueryData<{
      pages: Array<{ sessions: Array<{ id: string; lastRunStatus: string }> }>;
    }>(SESSIONS_QUERY_KEY);
    expect(data?.pages[0]?.sessions[0]?.lastRunStatus).toBe('idle');
  });

  it('stream:end（completed）：invalidate 会话缓存 + 用量汇总缓存', async () => {
    const invalidateSpy = vi.spyOn(globalQueryClient, 'invalidateQueries');
    renderHook(() => useAgentBridge(), { wrapper: createWrapper() });

    fireEnd({ sessionId: 's1', reason: 'completed', usage: { totalTokens: 150 } });

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: SESSIONS_QUERY_KEY }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['session', 's1'] }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['usage'] }));
  });

  it('stream:end：清理 agent-ask 弹窗状态（P2：超时后弹窗不得悬挂）', () => {
    useAgentAskStore.getState().enqueue({
      sessionId: 's1',
      askId: 'ask-1',
      questions: [{ question: '继续吗？', header: '确认', options: [] } as never],
      receivedAt: Date.now(),
    });
    expect(useAgentAskStore.getState().asks).toHaveLength(1);

    renderHook(() => useAgentBridge(), { wrapper: createWrapper() });
    fireEnd({ sessionId: 's1', reason: 'completed' });

    expect(useAgentAskStore.getState().asks).toHaveLength(0);
  });

  it('stream:end：仅清理审批缓冲；tool 缓冲保留（P3：右面板数据源）', () => {
    useToolStore.getState().appendToolCall({
      id: 'call-1',
      sessionId: 's1',
      toolName: 'read_file',
      input: {},
      permission: 'auto',
    });
    useApprovalsStore.getState().enqueue({
      id: 'a-1',
      sessionId: 's1',
      type: 'run_command',
      title: '执行命令',
      description: 'ls',
      input: { command: 'ls' },
      createdAt: Date.now(),
    });
    expect(useToolStore.getState().callsBySession.get('s1')?.length).toBe(1);
    expect(useApprovalsStore.getState().pending.length).toBe(1);

    renderHook(() => useAgentBridge(), { wrapper: createWrapper() });
    fireEnd({ sessionId: 's1', reason: 'aborted' });

    expect(useToolStore.getState().callsBySession.get('s1')?.length).toBe(1);
    expect(useApprovalsStore.getState().pending.length).toBe(0);
  });

  it('stream:error：同样 invalidate + 清理，并写入 turn-error-store（权威条目）', () => {
    const invalidateSpy = vi.spyOn(globalQueryClient, 'invalidateQueries');
    renderHook(() => useAgentBridge(), { wrapper: createWrapper() });

    fireError({ sessionId: 's1', code: 'INTERNAL_ERROR', message: 'boom' });

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: SESSIONS_QUERY_KEY }),
    );
    expect(useTurnErrorStore.getState().errors['s1']?.code).toBe('INTERNAL_ERROR');
    expect(useTurnErrorStore.getState().errors['s1']?.message).toBe('boom');
  });

  it('stream:start：清除该会话的上一回合错误卡条目（重连后不留旧错误）', () => {
    renderHook(() => useAgentBridge(), { wrapper: createWrapper() });
    fireError({ sessionId: 's1', code: 'INTERNAL_ERROR', message: 'boom' });
    expect(useTurnErrorStore.getState().errors['s1']).toBeDefined();

    fireStart({ sessionId: 's1' });
    expect(useTurnErrorStore.getState().errors['s1']).toBeUndefined();
  });

  /** 构造回合结束聚合声明域（与主进程 turnEndInvalidationDomains 等形） */
  function turnEndDomains(sessionId: string): string[] {
    return ['sessions', `session:${sessionId}`, 'goal', 'task', 'usage', 'git', 'file', 'turns'];
  }

  it('失效事件已覆盖该会话：stream:end 跳过旧清单（不重复失效）', () => {
    noteInvalidationEvent(turnEndDomains('s1'), 's1');
    expect(isTurnEndCovered('s1')).toBe(true);

    const invalidateSpy = vi.spyOn(globalQueryClient, 'invalidateQueries');
    renderHook(() => useAgentBridge(), { wrapper: createWrapper() });

    fireEnd({ sessionId: 's1', reason: 'completed' });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('事件缺失：回落旧清单（渐进兼容语义不回归）', () => {
    resetInvalidationCoverage();

    const invalidateSpy = vi.spyOn(globalQueryClient, 'invalidateQueries');
    renderHook(() => useAgentBridge(), { wrapper: createWrapper() });

    fireEnd({ sessionId: 's1', reason: 'completed' });

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: SESSIONS_QUERY_KEY }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['usage'] }));
  });

  it('事件已覆盖：L2 清理（审批缓冲 / 提问弹窗）仍无条件执行', () => {
    noteInvalidationEvent(turnEndDomains('s1'), 's1');
    useAgentAskStore.getState().enqueue({
      sessionId: 's1',
      askId: 'ask-1',
      questions: [{ question: '继续吗？', header: '确认', options: [] } as never],
      receivedAt: Date.now(),
    });
    useApprovalsStore.getState().enqueue({
      id: 'a-1',
      sessionId: 's1',
      type: 'run_command',
      title: '执行命令',
      description: 'ls',
      input: { command: 'ls' },
      createdAt: Date.now(),
    });

    renderHook(() => useAgentBridge(), { wrapper: createWrapper() });
    fireEnd({ sessionId: 's1', reason: 'completed' });

    expect(useAgentAskStore.getState().asks).toHaveLength(0);
    expect(useApprovalsStore.getState().pending.length).toBe(0);
  });
});
