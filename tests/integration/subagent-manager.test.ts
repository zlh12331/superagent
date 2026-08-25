// src/main/infra/ai/subagent-manager.test.ts
// 子代理管理器单测：内置代理列表/委派执行/结果收集/会话过滤

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../src/main/infra/storage/test-utils';

function createInMemoryDb() {
  return createTestDb();
}

vi.mock('../../src/main/infra/storage/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/infra/storage/db')>();
  let memoryDb: ReturnType<typeof createInMemoryDb> | null = null;
  return {
    ...actual,
    getDb: () => {
      if (memoryDb === null) {
        memoryDb = createInMemoryDb();
      }
      return memoryDb.db;
    },
    resetDb: () => {
      memoryDb = null;
    },
  };
});

import type { IAgentService } from '../../src/main/infra/ai/agent/agent-service';
import {
  getSubagentManager,
  initSubagentManager,
  SubagentManager,
} from '../../src/main/infra/ai/agent/subagent-manager';

/** fake agentService（无 mock 框架，手写最小实现） */
function createFakeAgent() {
  const turnListeners: Array<(event: unknown) => void> = [];
  const mockStartAgent = vi.fn(async (_options: unknown) => 'session-x');
  const stubs = {
    agentService: {
      startAgent: mockStartAgent,
      onTurnEvent: vi.fn((listener: (event: unknown) => void) => {
        turnListeners.push(listener);
        return () => {};
      }),
    } as unknown as IAgentService,
    turnListeners,
    mockStartAgent,
  };
  return stubs;
}

describe('SubagentManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('内置代理：list 含 general / code_review / plan', () => {
    const manager = new SubagentManager(createFakeAgent().agentService);
    const names = manager.list().map((s) => s.name);
    expect(names).toContain('general');
    expect(names).toContain('code_review');
    expect(names).toContain('plan');
  });

  it('run：委派独立回合（无头），按 sessionId 收集输出', async () => {
    const stubs = createFakeAgent();
    const manager = new SubagentManager(stubs.agentService);

    const promise = manager.run('general', '分析这段代码', '/tmp/proj');
    // startAgent 被调用（无头：无 webContents + 子代理 systemPrompt）
    await vi.waitFor(() => {
      expect(stubs.mockStartAgent).toHaveBeenCalledTimes(1);
    });
    const callArgs = stubs.mockStartAgent.mock.calls[0]?.[0] as {
      sessionId: string;
      webContents?: unknown;
      systemPrompt: string;
      workingDir: string;
      maxSteps: number;
    };
    expect(callArgs.webContents).toBeUndefined();
    expect(callArgs.workingDir).toBe('/tmp/proj');
    expect(callArgs.systemPrompt).toContain('通用子代理');
    expect(callArgs.maxSteps).toBe(15);

    // 模拟子代理回合事件（sessionId 过滤）
    const listener = stubs.turnListeners[0];
    expect(listener).toBeDefined();
    listener?.({
      type: 'text-delta',
      sessionId: 'other-session', // 其他回合事件应被忽略
      turnId: 'x1',
      timestamp: Date.now(),
      text: '不该被收集',
    });
    listener?.({
      type: 'text-delta',
      sessionId: callArgs.sessionId,
      turnId: 't1',
      timestamp: Date.now(),
      text: '分析结论：',
    });
    listener?.({
      type: 'turn-end',
      sessionId: callArgs.sessionId,
      turnId: 't1',
      timestamp: Date.now(),
      reason: 'completed',
      durationMs: 100,
    });

    const result = await promise;
    expect(result.output).toBe('分析结论：');
    expect(result.hasOutput).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('run：未知子代理抛错', async () => {
    const manager = new SubagentManager(createFakeAgent().agentService);
    await expect(manager.run('nonexistent', '任务', '/tmp')).rejects.toThrow('未知子代理');
  });

  it('init/get 单例：初始化后可获取', () => {
    const stubs = createFakeAgent();
    initSubagentManager(stubs.agentService);
    const manager = getSubagentManager();
    expect(manager.list().length).toBeGreaterThanOrEqual(3);
  });
});
