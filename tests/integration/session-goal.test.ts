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
    reclaimFreePages: () => {},
  };
});

import type { IAgentService } from '../../src/main/infra/ai/agent/agent-service';
import { GoalService } from '../../src/main/infra/ai/knowledge/goal-service';
import { resetDb } from '../../src/main/infra/storage/db';
import { SessionService } from '../../src/main/infra/storage/session-service';

/** 最小 agentService 依赖（GoalService 通过 DI 接口订阅回合事件；集成不验证 LLM 判定） */
function createAgentStub() {
  const turnListeners: Array<(event: unknown) => void> = [];
  const stub: IAgentService = {
    onTurnEvent: vi.fn((listener: (event: unknown) => void) => {
      turnListeners.push(listener);
      return () => {};
    }),
  } as unknown as IAgentService;
  return { stub, turnListeners };
}

describe('Session ↔ Goal 集成', () => {
  let sessionService: SessionService;
  let goalService: GoalService;

  beforeEach(() => {
    resetDb();
    sessionService = new SessionService();
    goalService = new GoalService(createAgentStub().stub, {
      judge: vi.fn(async () => ({ met: false, reason: '集成测试不判定', impossible: false })),
    } as never);
    goalService.mount();
  });

  it('跨服务数据一致：创建会话 → 创建目标 → 按会话过滤返回', async () => {
    const sessionId = await sessionService.create({ workingDir: '/repo/a' });
    await goalService.create(sessionId, '修复登录 500');

    const goals = await goalService.list(sessionId);
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({
      sessionId,
      condition: '修复登录 500',
      status: 'active',
    });
  });

  it('多会话目标不串：goal:list 按 sessionId 严格过滤', async () => {
    const a = await sessionService.create({ workingDir: '/repo/a' });
    const b = await sessionService.create({ workingDir: '/repo/b' });
    await goalService.create(a, '目标 A');
    await goalService.create(b, '目标 B');

    const goalsA = await goalService.list(a);
    const goalsB = await goalService.list(b);
    expect(goalsA.map((g) => g.condition)).toEqual(['目标 A']);
    expect(goalsB.map((g) => g.condition)).toEqual(['目标 B']);
  });

  it('goal:clear：目标标记 aborted（跨服务语义）', async () => {
    const sessionId = await sessionService.create({ workingDir: '/repo/a' });
    await goalService.create(sessionId, '目标');
    await goalService.clear(sessionId);

    const goals = await goalService.list(sessionId);
    expect(goals[0]?.status).toBe('aborted');
  });

  it('DB 级联约束：删除会话 → 其目标级联删除', async () => {
    const sessionId = await sessionService.create({ workingDir: '/repo/a' });
    await goalService.create(sessionId, '目标');

    await sessionService.delete(sessionId);
    const goals = await goalService.list(sessionId);
    expect(goals).toHaveLength(0);
  });
});
