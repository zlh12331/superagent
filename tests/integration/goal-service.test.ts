// src/main/infra/ai/goal-service.test.ts
// 目标服务单测：CRUD + 回合结束自动判定（内存 DB + fake judge）

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAgentService } from '../../src/main/infra/ai/agent/agent-service';
import type { GoalJudge } from '../../src/main/infra/ai/knowledge/goal-judge';
import { GoalService } from '../../src/main/infra/ai/knowledge/goal-service';
import { createTestDb } from '../../src/main/infra/storage/test-utils';

// mock getDb：内存数据库（drizzle 迁移，schema.ts 单一真源）
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

import { resetDb } from '../../src/main/infra/storage/db';
import { SessionService } from '../../src/main/infra/storage/session-service';

/** fake 依赖（无 mock 框架，手写最小实现） */
function createFakes() {
  const turnListeners: Array<(event: unknown) => void> = [];
  const mockJudge = vi.fn(async () => ({ met: false, reason: '证据不足', impossible: false }));
  const stubs = {
    agentService: {
      onTurnEvent: vi.fn((listener: (event: unknown) => void) => {
        turnListeners.push(listener);
        return () => {};
      }),
    } as unknown as IAgentService,
    goalJudge: {
      judge: mockJudge,
    } as unknown as GoalJudge,
    turnListeners,
    mockJudge,
  };
  return stubs;
}

/** 回合事件辅助 */
function textDelta(sid: string, text: string): unknown {
  return { type: 'text-delta', sessionId: sid, turnId: 't1', timestamp: Date.now(), text };
}
function turnEnd(sid: string): unknown {
  return {
    type: 'turn-end',
    sessionId: sid,
    turnId: 't1',
    timestamp: Date.now(),
    reason: 'completed',
    durationMs: 100,
  };
}

describe('GoalService', () => {
  let sessionService: SessionService;

  beforeAll(() => {
    resetDb();
  });

  beforeEach(() => {
    resetDb();
    sessionService = new SessionService();
    vi.clearAllMocks();
  });

  /** 建会话（goals 外键依赖 sessions） */
  async function createSession(): Promise<string> {
    return sessionService.create({
      workingDir: 'D:\\proj',
      title: undefined,
      messages: undefined,
    });
  }

  it('create：创建 active 目标（list 可查）', async () => {
    const stubs = createFakes();
    const service = new GoalService(stubs.agentService, stubs.goalJudge);
    service.mount();
    const sid = await createSession();

    await service.create(sid, '修复 login 500 错误');
    const goals = await service.list(sid);
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({
      sessionId: sid,
      condition: '修复 login 500 错误',
      status: 'active',
      iterations: 0,
    });
  });

  it('create 覆盖：旧目标标记 aborted，新目标 active', async () => {
    const stubs = createFakes();
    const service = new GoalService(stubs.agentService, stubs.goalJudge);
    service.mount();
    const sid = await createSession();

    await service.create(sid, '目标 A');
    await service.create(sid, '目标 B');
    const goals = await service.list(sid);
    expect(goals).toHaveLength(2);
    // 按创建时间倒序：最新目标在前（前端 goals[0] 即当前目标）
    expect(goals[0]?.status).toBe('active');
    expect(goals[0]?.condition).toBe('目标 B');
    expect(goals[1]?.status).toBe('aborted');
    expect(goals[1]?.condition).toBe('目标 A');
  });

  it('clear：标记 aborted（幂等）', async () => {
    const stubs = createFakes();
    const service = new GoalService(stubs.agentService, stubs.goalJudge);
    service.mount();
    const sid = await createSession();
    await service.create(sid, '目标');

    await service.clear(sid);
    const goals = await service.list(sid);
    expect(goals[0]?.status).toBe('aborted');
    await service.clear(sid); // 幂等
  });

  it('回合结束自动判定：judge 判定满足 → 目标 completed', async () => {
    const stubs = createFakes();
    const service = new GoalService(stubs.agentService, stubs.goalJudge);
    service.mount();
    const sid = await createSession();
    await service.create(sid, '修复 login');

    const listener = stubs.turnListeners[0];
    expect(listener).toBeDefined();
    listener?.(textDelta(sid, '已修复 login 500 错误'));
    stubs.mockJudge.mockResolvedValue({
      met: true,
      reason: '转录显示已修复',
      impossible: false,
    });
    listener?.(turnEnd(sid));

    await vi.waitFor(() => {
      expect(stubs.mockJudge).toHaveBeenCalledTimes(1);
    });
    const goals = await service.list(sid);
    expect(goals[0]?.status).toBe('completed');
    expect(goals[0]?.lastReason).toBe('转录显示已修复');
    expect(goals[0]?.iterations).toBe(1);
  });

  it('回合结束判定未满足：目标保持 active，iterations 递增', async () => {
    const stubs = createFakes();
    const service = new GoalService(stubs.agentService, stubs.goalJudge);
    service.mount();
    const sid = await createSession();
    await service.create(sid, '修复 login');

    const listener = stubs.turnListeners[0];
    listener?.(textDelta(sid, '分析中'));
    listener?.(turnEnd(sid));

    await vi.waitFor(() => {
      expect(stubs.mockJudge).toHaveBeenCalledTimes(1);
    });
    const goals = await service.list(sid);
    expect(goals[0]?.status).toBe('active');
    expect(goals[0]?.iterations).toBe(1);
  });

  it('无 active 目标：回合结束不判定', async () => {
    const stubs = createFakes();
    const service = new GoalService(stubs.agentService, stubs.goalJudge);
    service.mount();
    const sid = await createSession();

    const listener = stubs.turnListeners[0];
    listener?.(turnEnd(sid));

    await vi.waitFor(() => {
      expect(stubs.mockJudge).not.toHaveBeenCalled();
    });
  });
});
