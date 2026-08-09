// src/main/infra/im/im-agent-bridge.test.ts
// IM → Agent 桥接单测：安全模式检查 / 串行控制 / 回合事件回发

import type { ApprovalMode } from '@code-agent/shared/main';
import { TurnEventType } from '@code-agent/shared/main';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAgentService } from '../ai/agent/agent-service';
import type { IPermissionService } from '../ai/tools/permission-service';
import type { ISessionService } from '../storage/session-service';
import { IM_DEFAULT_WORKING_DIR, ImAgentBridge } from './im-agent-bridge';
import type { ImService } from './im-service';

/** 桥接依赖的轻量 stub（无 mock 框架：手写最小实现） */
function createStubs() {
  const sent: Array<{ kind: string; chatId: string; text: string }> = [];
  const messageHandlers: Array<(msg: unknown) => void> = [];
  const turnListeners: Array<(event: unknown) => void> = [];
  // vi.fn 实例先保存（cast 成接口后 mock 方法被类型收窄）
  const mockSend = vi.fn(async (kind: string, chatId: string, text: string) => {
    sent.push({ kind, chatId, text });
  });
  const mockOnMessage = vi.fn((handler: (msg: unknown) => void) => {
    messageHandlers.push(handler);
    return () => {};
  });
  const mockStartAgent = vi.fn(async (_options: unknown) => 'session-1');
  const mockOnTurnEvent = vi.fn((listener: (event: unknown) => void) => {
    turnListeners.push(listener);
    return () => {};
  });
  const mockGetApprovalMode = vi.fn((): ApprovalMode => 'auto');
  const mockSessionCreate = vi.fn(async (_options: unknown) => 'session-1');
  const mockAppendMessage = vi.fn(async (_options: unknown) => 1);
  const stubs = {
    imService: {
      send: mockSend,
      onMessage: mockOnMessage,
    } as unknown as ImService,
    agentService: {
      startAgent: mockStartAgent,
      onTurnEvent: mockOnTurnEvent,
    } as unknown as IAgentService,
    permissionService: {
      getApprovalMode: mockGetApprovalMode,
    } as unknown as IPermissionService,
    sessionService: {
      create: mockSessionCreate,
      appendMessage: mockAppendMessage,
    } as unknown as ISessionService,
    sent,
    turnListeners,
    messageHandlers,
    mockStartAgent,
    mockGetApprovalMode,
    mockSessionCreate,
    mockAppendMessage,
  };
  return stubs;
}

/** 模拟渠道入站消息 */
function incoming(overrides: Partial<{ text: string; chatId: string; messageId: string }> = {}) {
  return {
    channel: 'telegram',
    chatId: 'chat-1',
    senderId: 'user-1',
    text: '你好',
    messageId: 'm1',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('ImAgentBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ask 模式：拒绝执行并回发提示（无审批通道）', async () => {
    const stubs = createStubs();
    stubs.mockGetApprovalMode.mockReturnValue('ask');
    const bridge = new ImAgentBridge(
      stubs.imService,
      stubs.agentService,
      stubs.permissionService,
      stubs.sessionService,
    );
    bridge.mount();

    stubs.messageHandlers[0]?.(incoming());
    await vi.waitFor(() => {
      expect(stubs.agentService.startAgent).not.toHaveBeenCalled();
    });
    expect(stubs.sent[0]?.text).toContain('审批模式');
  });

  it('auto 模式：执行回合（无头 startAgent），TURN_END 回发汇总', async () => {
    const stubs = createStubs();
    const bridge = new ImAgentBridge(
      stubs.imService,
      stubs.agentService,
      stubs.permissionService,
      stubs.sessionService,
    );
    bridge.mount();

    stubs.messageHandlers[0]?.(incoming({ text: '帮我看看代码' }));
    await vi.waitFor(() => {
      expect(stubs.mockStartAgent).toHaveBeenCalledTimes(1);
    });

    // 断言无头调用：不传 webContents + 用户主目录
    const callArgs = stubs.mockStartAgent.mock.calls[0]?.[0] as {
      webContents?: unknown;
      workingDir: string;
      sessionId: string;
    };
    expect(callArgs.workingDir).toBe(IM_DEFAULT_WORKING_DIR);
    expect(callArgs.webContents).toBeUndefined();
    expect(callArgs.sessionId).toBeTruthy();

    // 模拟回合事件：回合开始（捕获 turnId）→ 文本增量 → 工具调用 → 回合结束
    const listener = stubs.turnListeners[0];
    expect(listener).toBeDefined();
    listener?.({
      type: TurnEventType.TURN_START,
      sessionId: callArgs.sessionId,
      turnId: 'turn-1',
      timestamp: Date.now(),
      modelId: 'deepseek-v4-flash',
    });
    listener?.({
      type: TurnEventType.TEXT_DELTA,
      sessionId: callArgs.sessionId,
      turnId: 'turn-1',
      timestamp: Date.now(),
      text: '分析中',
    });
    listener?.({
      type: TurnEventType.TOOL_CALL,
      sessionId: callArgs.sessionId,
      turnId: 'turn-1',
      timestamp: Date.now(),
      toolCallId: 'c1',
      toolName: 'read_file',
    });
    listener?.({
      type: TurnEventType.TURN_END,
      sessionId: callArgs.sessionId,
      turnId: 'turn-1',
      timestamp: Date.now(),
      reason: 'completed',
      durationMs: 100,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });

    await vi.waitFor(() => {
      // 结束汇总回发（含工具 + tokens）
      expect(stubs.sent.some((s) => s.text.includes('✅ 完成'))).toBe(true);
      expect(stubs.sent.some((s) => s.text.includes('🔧 read_file'))).toBe(true);
      expect(stubs.sent.some((s) => s.text.includes('Tokens: 150'))).toBe(true);
    });

    // Transcript 落库：user + assistant 消息（带 turnId 关联）
    await vi.waitFor(() => {
      expect(stubs.mockAppendMessage).toHaveBeenCalledTimes(1);
    });
    const appendArgs = stubs.mockAppendMessage.mock.calls[0]?.[0] as {
      sessionId: string;
      turnId: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(appendArgs.sessionId).toBe(callArgs.sessionId);
    expect(appendArgs.turnId).toBe('turn-1');
    expect(appendArgs.messages[0]).toEqual({ role: 'user', content: '帮我看看代码' });
    expect(appendArgs.messages[1]?.content).toContain('分析中');
  });

  it('串行控制：执行中收到新消息回发排队提示', async () => {
    const stubs = createStubs();
    const bridge = new ImAgentBridge(
      stubs.imService,
      stubs.agentService,
      stubs.permissionService,
      stubs.sessionService,
    );
    bridge.mount();

    // 第一条消息开始执行（startAgent 不 resolve 完成信号——事件驱动）
    stubs.messageHandlers[0]?.(incoming({ messageId: 'm1' }));
    await vi.waitFor(() => {
      expect(stubs.mockStartAgent).toHaveBeenCalledTimes(1);
    });

    // 执行中第二条消息：排队提示
    stubs.messageHandlers[0]?.(incoming({ messageId: 'm2', text: '再来一条' }));
    await vi.waitFor(() => {
      expect(stubs.sent.some((s) => s.text.includes('执行中'))).toBe(true);
    });
    // startAgent 只被调用一次
    expect(stubs.mockStartAgent).toHaveBeenCalledTimes(1);
  });

  it('首次消息：创建 IM 会话（标题标记渠道来源）', async () => {
    const stubs = createStubs();
    const bridge = new ImAgentBridge(
      stubs.imService,
      stubs.agentService,
      stubs.permissionService,
      stubs.sessionService,
    );
    bridge.mount();

    stubs.messageHandlers[0]?.(incoming({ chatId: 'chat-99' }));
    await vi.waitFor(() => {
      expect(stubs.mockSessionCreate).toHaveBeenCalledTimes(1);
    });
    const createArgs = stubs.mockSessionCreate.mock.calls[0]?.[0] as {
      workingDir: string;
      title: string;
    };
    expect(createArgs.title).toBe('IM:telegram:chat-99');
    expect(createArgs.workingDir).toBe(IM_DEFAULT_WORKING_DIR);
  });
});
