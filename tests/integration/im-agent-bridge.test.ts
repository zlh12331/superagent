// tests/integration/im-agent-bridge.test.ts
// IM → Agent 回合闭环集成测试：真实 SessionService（内存 SQLite）落库验证
// ──────────────────────────────────────────────────────────────
// 单测（src/main/infra/im/im-agent-bridge.test.ts）用 stub sessionService 验证
// "调用了 appendMessage"；本集成测试用真实 SessionService + 内存库验证
// "transcript 真的落库并能查回来"（协作面：IM 桥接 × 会话存储）。AgentService
// 是外部 LLM 边界，仍用 stub（集成不走真实 LLM）。
// ──────────────────────────────────────────────────────────────

import type { ApprovalMode } from '@code-agent/shared/main';
import { TurnEventType } from '@code-agent/shared/main';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAgentService } from '../../src/main/infra/ai/agent/agent-service';
import type { IPermissionService } from '../../src/main/infra/ai/tools/permission-service';
import { ImAgentBridge } from '../../src/main/infra/im/im-agent-bridge';
import type { ImService } from '../../src/main/infra/im/im-service';
import { resetDb } from '../../src/main/infra/storage/db';
import { SessionService } from '../../src/main/infra/storage/session-service';
import { createTestDb } from '../../src/main/infra/storage/test-utils';

// 内存 DB 注入（真实 SessionService 落库用）
vi.mock('../../src/main/infra/storage/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/infra/storage/db')>();
  let memoryDb: ReturnType<typeof createTestDb> | null = null;
  return {
    ...actual,
    getDb: () => {
      if (memoryDb === null) memoryDb = createTestDb();
      return memoryDb.db;
    },
    resetDb: () => {
      memoryDb = null;
    },
    // reclaimFreePages 引原 getDb（真实 dbInstance 未初始化）——集成用内存库，no-op
    reclaimFreePages: () => {},
  };
});

// IM 渠道入站消息形状
function incoming(overrides: Partial<{ text: string; chatId: string }> = {}) {
  return {
    channel: 'telegram',
    chatId: 'chat-1',
    senderId: 'user-1',
    text: '帮我看看代码',
    messageId: 'm1',
    timestamp: Date.now(),
    ...overrides,
  };
}

/** 最小 AgentService stub（无头 startAgent + 回合事件订阅；不验证 LLM 判定） */
function createAgentStub() {
  const turnListeners: Array<(event: unknown) => void> = [];
  const startAgent = vi.fn(async () => 'session-1');
  const stub = {
    onTurnEvent: vi.fn((listener: (event: unknown) => void) => {
      turnListeners.push(listener);
      return () => {};
    }),
    startAgent,
  } as unknown as IAgentService;
  return { stub, turnListeners, startAgent };
}

/** IM 服务 stub：收集回发消息 + 暴露 onMessage 注册 */
function createImStub() {
  const sent: Array<{ channel: string; chatId: string; text: string }> = [];
  const messageHandlers: Array<(msg: unknown) => void> = [];
  const imService = {
    send: vi.fn(async (channel: string, chatId: string, text: string) => {
      sent.push({ channel, chatId, text });
    }),
    onMessage: vi.fn((handler: (msg: unknown) => void) => {
      messageHandlers.push(handler);
      return () => {};
    }),
  } as unknown as ImService;
  return { imService, sent, messageHandlers };
}

describe('IM → Agent 回合闭环（真实 SessionService 落库）', () => {
  let sessionService: SessionService;
  let bridge: ImAgentBridge;
  let im: ReturnType<typeof createImStub>;
  let agent: ReturnType<typeof createAgentStub>;
  let permission: IPermissionService;

  beforeEach(() => {
    resetDb();
    sessionService = new SessionService();
    im = createImStub();
    agent = createAgentStub();
    permission = {
      getApprovalMode: vi.fn((): ApprovalMode => 'auto'),
    } as unknown as IPermissionService;
    bridge = new ImAgentBridge(im.imService, agent.stub, permission, sessionService);
    bridge.mount();
  });

  it('auto 模式：回合结束把 user + assistant 消息真实落库到会话', async () => {
    im.messageHandlers[0]?.(incoming({ text: '帮我看看代码' }));
    await vi.waitFor(() => expect(agent.startAgent).toHaveBeenCalledTimes(1));

    // 模拟回合事件流（startAgent 返回的 sessionId）
    const runArgs = agent.startAgent.mock.calls[0]?.[0] as { sessionId: string };
    agent.turnListeners[0]?.({
      type: TurnEventType.TURN_START,
      sessionId: runArgs.sessionId,
      turnId: 'turn-1',
      timestamp: Date.now(),
      modelId: 'm',
    });
    agent.turnListeners[0]?.({
      type: TurnEventType.TEXT_DELTA,
      sessionId: runArgs.sessionId,
      turnId: 'turn-1',
      timestamp: Date.now(),
      text: '分析中',
    });
    agent.turnListeners[0]?.({
      type: TurnEventType.TURN_END,
      sessionId: runArgs.sessionId,
      turnId: 'turn-1',
      timestamp: Date.now(),
      reason: 'completed',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });

    // 落库完成：会话消息能查回（真实 SessionService + 内存库）
    await vi.waitFor(async () => {
      const { messages } = await sessionService.get(runArgs.sessionId);
      // 落库消息为 ModelMessage（含 role/content），验证 user 与 assistant 都在
      const userMsg = messages.find((m) => (m as { role?: string }).role === 'user');
      const assistantMsg = messages.find((m) => (m as { role?: string }).role === 'assistant');
      expect(String((userMsg as { content?: unknown })?.content)).toContain('帮我看看代码');
      expect(String((assistantMsg as { content?: unknown })?.content)).toContain('分析中');
    });
  });

  it('回合结束后：回发包含工具摘要与 token 统计', async () => {
    im.messageHandlers[0]?.(incoming({ text: '跑个命令' }));
    await vi.waitFor(() => expect(agent.startAgent).toHaveBeenCalledTimes(1));
    const runArgs = agent.startAgent.mock.calls[0]?.[0] as { sessionId: string };

    agent.turnListeners[0]?.({
      type: TurnEventType.TURN_START,
      sessionId: runArgs.sessionId,
      turnId: 't-2',
      timestamp: Date.now(),
      modelId: 'm',
    });
    agent.turnListeners[0]?.({
      type: TurnEventType.TOOL_CALL,
      sessionId: runArgs.sessionId,
      turnId: 't-2',
      timestamp: Date.now(),
      toolCallId: 'c1',
      toolName: 'run_command',
    });
    agent.turnListeners[0]?.({
      type: TurnEventType.TURN_END,
      sessionId: runArgs.sessionId,
      turnId: 't-2',
      timestamp: Date.now(),
      reason: 'completed',
      usage: { totalTokens: 200 },
    });

    await vi.waitFor(() => {
      expect(im.sent.some((s) => s.text.includes('✅ 完成'))).toBe(true);
      expect(im.sent.some((s) => s.text.includes('🔧 run_command'))).toBe(true);
      expect(im.sent.some((s) => s.text.includes('Tokens: 200'))).toBe(true);
    });
  });

  it('ask 模式：拒绝无头执行，不发回合、回发提示', async () => {
    (permission.getApprovalMode as ReturnType<typeof vi.fn>).mockReturnValue('ask');
    im.messageHandlers[0]?.(incoming());
    await vi.waitFor(() => expect(agent.startAgent).not.toHaveBeenCalled());
    expect(im.sent[0]?.text).toContain('审批模式');
  });

  it('串行控制：执行中收到新消息回发排队提示，不发新回合', async () => {
    im.messageHandlers[0]?.(incoming({ messageId: 'm1' }));
    await vi.waitFor(() => expect(agent.startAgent).toHaveBeenCalledTimes(1));
    im.messageHandlers[0]?.(incoming({ messageId: 'm2', text: '再来一条' }));
    await vi.waitFor(() => {
      expect(im.sent.some((s) => s.text.includes('执行中'))).toBe(true);
    });
    expect(agent.startAgent).toHaveBeenCalledTimes(1);
  });
});
