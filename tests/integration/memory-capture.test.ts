// tests/integration/memory-capture.test.ts
// MemoryHub 回合捕获接线集成测试：capture-wire × 回合事件流
// ──────────────────────────────────────────────────────────────
// 单测（src/main/infra/memory-hub/capture-wire.test.ts）用 stub TurnEvent 验证
// "capture 被调用"；本集成测试验证接线协作：capture 的 sessionKey 用真实
// sessionId、用户/助手内容按事件流正确拼接、非 completed 回合不捕获。
// MemoryPort 是外部记忆引擎边界，用 fake 收集调用（不走真实 sidecar）。
// ──────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAgentService } from '../../src/main/infra/ai/agent/agent-service';
import {
  createMemoryCaptureWire,
  extractLastUserText,
} from '../../src/main/infra/memory-hub/capture-wire';
import type { MemoryCaptureInput, MemoryPort } from '../../src/main/infra/memory-hub/types';

/** 收集 capture 调用的 fake MemoryPort */
function createFakePort() {
  const captures: MemoryCaptureInput[] = [];
  const port = {
    capture: vi.fn(async (input: MemoryCaptureInput) => {
      captures.push(input);
      return { l0Recorded: 1, schedulerNotified: true };
    }),
    recall: vi.fn(async () => ({ ok: true, context: '', memoryCount: 0 })),
    searchMemories: vi.fn(async () => ({ ok: true, context: '', memoryCount: 0 })),
    searchConversations: vi.fn(async () => []),
    clear: vi.fn(async () => ({ ok: true, clearedCount: 0 })),
  } as unknown as MemoryPort;
  return { port, captures };
}

/** stub IAgentService（onTurnEvent 注册监听；集成不验证 LLM） */
function createAgentStub() {
  const turnListeners: Array<(event: unknown) => void> = [];
  const stub = {
    onTurnEvent: vi.fn((listener: (event: unknown) => void) => {
      turnListeners.push(listener);
      return () => {};
    }),
  } as unknown as IAgentService;
  return { stub, turnListeners };
}

function turnEvent(partial: Record<string, unknown>) {
  return {
    type: 'text-delta',
    sessionId: 'sess-1',
    turnId: 't-1',
    timestamp: Date.now(),
    ...partial,
  };
}

describe('MemoryHub 回合捕获接线', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('回合结束(completed)：capture 用真实 sessionId 作为 sessionKey，内容按事件流拼接', async () => {
    const agent = createAgentStub();
    const { port, captures } = createFakePort();
    const wire = createMemoryCaptureWire({ agentService: agent.stub, port });

    // handler 在 run 前注入用户文本（真实链路：agent.handler 调 noteLastUser）
    wire.noteLastUser('sess-1', '帮我修 bug');

    // 模拟回合事件流：start → 两段 text-delta → end(completed)
    agent.turnListeners[0]?.(turnEvent({ type: 'turn-start', sessionId: 'sess-1' }));
    agent.turnListeners[0]?.(
      turnEvent({ type: 'text-delta', sessionId: 'sess-1', text: '第一段 ' }),
    );
    agent.turnListeners[0]?.(
      turnEvent({ type: 'text-delta', sessionId: 'sess-1', text: '第二段' }),
    );
    agent.turnListeners[0]?.(
      turnEvent({ type: 'turn-end', sessionId: 'sess-1', reason: 'completed' }),
    );

    await vi.waitFor(() => expect(captures).toHaveLength(1));
    expect(captures[0]).toEqual({
      sessionKey: 'sess-1',
      userContent: '帮我修 bug',
      assistantContent: '第一段 第二段',
    });
    expect(port.capture).toHaveBeenCalledTimes(1);
  });

  it('按会话隔离：多会话并发回合各自捕获，不串 sessionKey', async () => {
    const agent = createAgentStub();
    const { port, captures } = createFakePort();
    const wire = createMemoryCaptureWire({ agentService: agent.stub, port });

    wire.noteLastUser('sess-a', '会话 A 问题');
    wire.noteLastUser('sess-b', '会话 B 问题');

    // 会话 A 回合
    agent.turnListeners[0]?.(turnEvent({ type: 'turn-start', sessionId: 'sess-a' }));
    agent.turnListeners[0]?.(
      turnEvent({ type: 'text-delta', sessionId: 'sess-a', text: 'A 回答' }),
    );
    agent.turnListeners[0]?.(
      turnEvent({ type: 'turn-end', sessionId: 'sess-a', reason: 'completed' }),
    );

    // 会话 B 回合
    agent.turnListeners[0]?.(turnEvent({ type: 'turn-start', sessionId: 'sess-b' }));
    agent.turnListeners[0]?.(
      turnEvent({ type: 'text-delta', sessionId: 'sess-b', text: 'B 回答' }),
    );
    agent.turnListeners[0]?.(
      turnEvent({ type: 'turn-end', sessionId: 'sess-b', reason: 'completed' }),
    );

    await vi.waitFor(() => expect(captures).toHaveLength(2));
    const byKey = Object.fromEntries(captures.map((c) => [c.sessionKey, c]));
    expect(byKey['sess-a']?.userContent).toBe('会话 A 问题');
    expect(byKey['sess-a']?.assistantContent).toBe('A 回答');
    expect(byKey['sess-b']?.userContent).toBe('会话 B 问题');
    expect(byKey['sess-b']?.assistantContent).toBe('B 回答');
  });

  it('非 completed 回合不捕获（aborted/error 不写 L0）', async () => {
    const agent = createAgentStub();
    const { port, captures } = createFakePort();
    const innerWire = createMemoryCaptureWire({ agentService: agent.stub, port });

    innerWire.noteLastUser('sess-1', '中断的问题');
    agent.turnListeners[0]?.(turnEvent({ type: 'turn-start', sessionId: 'sess-1' }));
    agent.turnListeners[0]?.(
      turnEvent({ type: 'turn-end', sessionId: 'sess-1', reason: 'aborted' }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(captures).toHaveLength(0);
  });

  it('extractLastUserText：兼容 UIMessage parts 形状与 string content', () => {
    // parts 数组（UIMessage 形状）
    expect(extractLastUserText([{ role: 'user', parts: [{ type: 'text', text: '你好' }] }])).toBe(
      '你好',
    );
    // string content
    expect(extractLastUserText([{ role: 'user', content: '直接文本' }])).toBe('直接文本');
    // 空/非数组
    expect(extractLastUserText(undefined)).toBe('');
    expect(extractLastUserText([])).toBe('');
  });
});
