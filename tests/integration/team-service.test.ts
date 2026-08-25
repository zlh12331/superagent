// src/main/infra/ai/team-service.test.ts
// 团队服务单测：并行委派 + 结果汇总 + 失败隔离

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
import { SubagentManager } from '../../src/main/infra/ai/agent/subagent-manager';
import { TeamService } from '../../src/main/infra/ai/agent/team-service';

/** fake agentService（无 mock 框架，手写最小实现） */
function createFakeAgent() {
  const turnListeners: Array<(event: unknown) => void> = [];
  const mockStartAgent = vi.fn(async (_options: unknown) => 'session-x');
  return {
    mockStartAgent,
    agentService: {
      startAgent: mockStartAgent,
      onTurnEvent: vi.fn((listener: (event: unknown) => void) => {
        turnListeners.push(listener);
        return () => {};
      }),
    } as unknown as IAgentService,
    turnListeners,
  };
}

describe('TeamService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runTeam：并行委派多成员并汇总结果', async () => {
    const stubs = createFakeAgent();
    const service = new TeamService(new SubagentManager(stubs.agentService));

    const promise = service.runTeam(
      [
        { agent: 'general', task: '任务 A' },
        { agent: 'plan', task: '任务 B' },
      ],
      '/tmp/proj',
    );

    // 两个成员都被委派（2 次 startAgent）
    await vi.waitFor(() => {
      expect(stubs.mockStartAgent).toHaveBeenCalledTimes(2);
    });

    // 完成两个成员回合（各自 sessionId）
    const listeners = stubs.turnListeners;
    const sessionIds = new Set<string>();
    for (const call of stubs.mockStartAgent.mock.calls) {
      const args = call[0] as { sessionId: string };
      sessionIds.add(args.sessionId);
    }
    const ids = [...sessionIds];
    let index = 0;
    for (const listener of listeners) {
      const sid = ids[index % ids.length];
      listener?.({
        type: 'text-delta',
        sessionId: sid,
        turnId: `t${index}`,
        timestamp: Date.now(),
        text: `成员${index + 1}结论`,
      });
      listener?.({
        type: 'turn-end',
        sessionId: sid,
        turnId: `t${index}`,
        timestamp: Date.now(),
        reason: 'completed',
        durationMs: 100,
      });
      index += 1;
    }

    const result = await promise;
    expect(result.members).toHaveLength(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.members.some((m) => m.output.includes('成员1结论'))).toBe(true);
    expect(result.members.some((m) => m.output.includes('成员2结论'))).toBe(true);
  });

  it('runTeam：成员失败不阻断团队（失败隔离）', async () => {
    const stubs = createFakeAgent();
    // 第二个成员回合抛错（模拟异常）
    const service = new TeamService(new SubagentManager(stubs.agentService));

    const promise = service.runTeam(
      [
        { agent: 'nonexistent', task: '任务 A' }, // 未知代理 → run 立即抛错
        { agent: 'nonexistent', task: '任务 B' },
      ],
      '/tmp/proj',
    );

    const result = await promise;
    expect(result.members).toHaveLength(2);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.leaderSummary).toBeNull();
    const failedMember = result.members.find((m) => !m.success);
    expect(failedMember?.output).toContain('失败');
  });

  it('runTeam：leader 汇总（成员完成后领导聚合结论）', async () => {
    const stubs = createFakeAgent();
    const service = new TeamService(new SubagentManager(stubs.agentService));

    const promise = service.runTeam([{ agent: 'general', task: '任务 A' }], '/tmp/proj', {
      agent: 'general',
    });

    // 阶段 1：成员回合委派
    await vi.waitFor(() => {
      expect(stubs.mockStartAgent).toHaveBeenCalledTimes(1);
    });
    const memberCall = stubs.mockStartAgent.mock.calls[0];
    if (memberCall === undefined) {
      throw new Error('成员回合未委派');
    }
    const memberSid = (memberCall[0] as { sessionId: string }).sessionId;
    const listener = stubs.turnListeners[0];
    expect(listener).toBeDefined();
    listener?.({
      type: 'text-delta',
      sessionId: memberSid,
      turnId: 'tm',
      timestamp: Date.now(),
      text: '成员结论',
    });
    listener?.({
      type: 'turn-end',
      sessionId: memberSid,
      turnId: 'tm',
      timestamp: Date.now(),
      reason: 'completed',
      durationMs: 100,
    });

    // 阶段 2：成员完成后领导回合委派
    await vi.waitFor(() => {
      expect(stubs.mockStartAgent).toHaveBeenCalledTimes(2);
    });
    const leaderCall = stubs.mockStartAgent.mock.calls[1];
    if (leaderCall === undefined) {
      throw new Error('领导回合未委派');
    }
    const leaderSid = (leaderCall[0] as { sessionId: string }).sessionId;
    const leaderListener = stubs.turnListeners[1];
    expect(leaderListener).toBeDefined();
    leaderListener?.({
      type: 'text-delta',
      sessionId: leaderSid,
      turnId: 'tl',
      timestamp: Date.now(),
      text: '团队结论：整体可行',
    });
    leaderListener?.({
      type: 'turn-end',
      sessionId: leaderSid,
      turnId: 'tl',
      timestamp: Date.now(),
      reason: 'completed',
      durationMs: 100,
    });

    const result = await promise;
    expect(result.leaderSummary).toContain('团队结论');
    expect(result.succeeded).toBe(1);
  });
});
