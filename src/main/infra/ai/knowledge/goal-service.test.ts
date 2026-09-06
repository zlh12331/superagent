// src/main/infra/ai/knowledge/goal-service.test.ts
// 会话目标服务单测：CRUD + 回合事件驱动自动判定（内存 DB + mock 依赖）

import type { TurnEvent } from '@code-agent/shared/main';
import { TurnEventType } from '@code-agent/shared/main';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, resetDb } from '../../storage/db';
import { sessions } from '../../storage/schema';
import { createTestDb } from '../../storage/test-utils';
import type { IAgentService } from '../agent/agent-service';
import type { GoalJudge } from './goal-judge';
import { GoalService } from './goal-service';

vi.mock('../../storage/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../storage/db')>();
  let memoryDb: ReturnType<typeof createTestDb>['db'] | null = null;
  return {
    ...actual,
    getDb: () => {
      if (memoryDb === null) {
        memoryDb = createTestDb().db;
      }
      return memoryDb;
    },
    resetDb: () => {
      memoryDb = null;
    },
  };
});

/** 捕获 mount 注册的回合回调（handleTurnEvent 是私有方法） */
function captureTurnHandler(agentService: { onTurnEvent: ReturnType<typeof vi.fn> }) {
  return agentService.onTurnEvent.mock.calls[0]?.[0] as (event: TurnEvent) => Promise<void>;
}

describe('GoalService', () => {
  let agentService: { onTurnEvent: ReturnType<typeof vi.fn> };
  let goalJudge: { judge: ReturnType<typeof vi.fn> };
  let service: GoalService;

  beforeEach(() => {
    resetDb();
    agentService = { onTurnEvent: vi.fn(() => () => {}) };
    goalJudge = { judge: vi.fn(async () => ({ met: false, reason: '未达成', impossible: false })) };
    // goals.session_id 外键引用 sessions.id，预插会话行（goals 与 tasks 不同，有 FK）
    getDb()
      .insert(sessions)
      .values({
        id: 's1',
        title: '测试会话',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        workingDir: '/tmp',
      })
      .run();
    service = new GoalService(
      agentService as unknown as IAgentService,
      goalJudge as unknown as GoalJudge,
    );
    service.mount();
    void getDb;
  });

  it('create：每会话单一 active 目标，新建覆盖旧（旧标记 aborted）', async () => {
    await service.create('s1', '条件 A');
    await service.create('s1', '条件 B');
    const goals = await service.list('s1');
    expect(goals).toHaveLength(2);
    expect(goals[0]?.status).toBe('active');
    expect(goals[0]?.condition).toBe('条件 B');
    expect(goals[1]?.status).toBe('aborted');
  });

  it('回合结束 + met=true → 目标 completed', async () => {
    await service.create('s1', '让测试通过');
    goalJudge.judge.mockResolvedValueOnce({ met: true, reason: '测试绿了', impossible: false });
    const handler = captureTurnHandler(agentService);
    await handler({ type: TurnEventType.TEXT_DELTA, sessionId: 's1', text: 'done' } as TurnEvent);
    await handler({ type: TurnEventType.TURN_END, sessionId: 's1' } as TurnEvent);
    const goals = await service.list('s1');
    expect(goals[0]?.status).toBe('completed');
    expect(goalJudge.judge).toHaveBeenCalledWith('让测试通过', 'done');
  });

  it('回合结束 + impossible=true → 目标 aborted', async () => {
    await service.create('s1', '不可能任务');
    goalJudge.judge.mockResolvedValueOnce({ met: false, reason: '自相矛盾', impossible: true });
    const handler = captureTurnHandler(agentService);
    await handler({ type: TurnEventType.TEXT_DELTA, sessionId: 's1', text: '尝试' } as TurnEvent);
    await handler({ type: TurnEventType.TURN_END, sessionId: 's1' } as TurnEvent);
    const goals = await service.list('s1');
    expect(goals[0]?.status).toBe('aborted');
  });

  it('没有 active 目标 → 回合结束跳过判定', async () => {
    const handler = captureTurnHandler(agentService);
    await handler({ type: TurnEventType.TURN_END, sessionId: 's-x' } as TurnEvent);
    expect(goalJudge.judge).not.toHaveBeenCalled();
  });

  it('空转录（纯工具回合）→ 不判定', async () => {
    await service.create('s1', 'x');
    const handler = captureTurnHandler(agentService);
    await handler({ type: TurnEventType.TURN_END, sessionId: 's1' } as TurnEvent);
    expect(goalJudge.judge).not.toHaveBeenCalled();
  });

  it('judge 抛错 → evaluate 不阻塞、目标保持 active', async () => {
    await service.create('s1', 'x');
    goalJudge.judge.mockRejectedValueOnce(new Error('judge fail'));
    const handler = captureTurnHandler(agentService);
    await handler({ type: TurnEventType.TEXT_DELTA, sessionId: 's1', text: 'noise' } as TurnEvent);
    await handler({ type: TurnEventType.TURN_END, sessionId: 's1' } as TurnEvent);
    const goals = await service.list('s1');
    expect(goals[0]?.status).toBe('active');
  });

  it('clear：目标标记 aborted', async () => {
    await service.create('s1', 'x');
    await service.clear('s1');
    expect((await service.list('s1'))[0]?.status).toBe('aborted');
  });
});
