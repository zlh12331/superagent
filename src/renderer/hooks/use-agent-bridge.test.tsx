// src/renderer/hooks/use-agent-bridge.test.tsx
// use-agent-bridge 单测：回合结束 → invalidate 缓存 + 清理 L2 缓冲 + usage 累积
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
    // 清空 L2 store 与全局 queryClient 残留
    useToolStore.getState().clearBySession('s1');
    useApprovalsStore.getState().clearBySession('s1');
    useAgentAskStore.getState().clearAsk();
    useTurnErrorStore.setState({ errors: {} });
    globalQueryClient.clear();
    // 清空回合结束覆盖登记（31 号：避免用例间失效事件状态串扰）
    resetInvalidationCoverage();

    // 订阅回调捕获
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
    // 预置分页缓存（InfiniteData<SessionListData> 形状，与 use-sessions 同构）
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
    // 方案语义：start 走 setQueryData（免重拉 + 免 markRunning 落库竞态），不 invalidate
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

    // invalidate 已调用（会话列表 + 会话详情 + 用量汇总前缀）
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: SESSIONS_QUERY_KEY }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['session', 's1'] }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['usage'] }));
  });

  it('stream:end：清理 agent-ask 弹窗状态（P2：超时后弹窗不得悬挂）', () => {
    // 会话归属：入队带 sessionId，回合 end 按会话精确清理（队列形态）
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
    // 预置 L2 数据
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

    // P3 修复：tool 缓冲回合后保留（右面板 DiffPane 数据源），仅审批缓冲清空
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
    // 对话区错误卡数据源：code + 消息原文（未经 SDK 脱敏）
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

  // ── 渐进回落（31 号 spec §2.5c）：事件覆盖 → 跳过旧清单；L2 清理不受影响 ──

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
