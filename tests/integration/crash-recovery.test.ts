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

import { resetDb } from '../../src/main/infra/storage/db';
import { SessionService } from '../../src/main/infra/storage/session-service';

/** 真实消息（与 agent 持久化格式一致） */
function makeMessage(i: number) {
  return { role: 'user' as const, content: `崩溃前消息 ${i}` };
}

describe('崩溃恢复链路（集成）', () => {
  let sessionService: SessionService;

  beforeEach(() => {
    resetDb();
    sessionService = new SessionService();
  });

  /** 模拟进程重启：仅重建服务实例（进程内状态丢失），DB 保持（真实持久化语义） */
  function simulateRestart(): void {
    sessionService = new SessionService();
  }

  it('主链路：running 残留 → 重启 → markAllInterrupted 全部归位', async () => {
    const a = await sessionService.create({ workingDir: '/repo/a' });
    await sessionService.markRunning(a);
    const b = await sessionService.create({ workingDir: '/repo/b' });
    await sessionService.markRunning(b);
    await sessionService.markIdle(b);

    simulateRestart();
    const affected = await sessionService.markAllInterrupted();

    expect(affected, '只有 running 残留被重置（1 个）').toBe(1);
    const aMeta = (await sessionService.list(100, 0)).sessions.find((s) => s.id === a);
    const bMeta = (await sessionService.list(100, 0)).sessions.find((s) => s.id === b);
    expect(aMeta?.lastRunStatus).toBe('interrupted');
    expect(bMeta?.lastRunStatus).toBe('idle');
  });

  it('只重置 running：interrupted/idle 混合状态不被误伤', async () => {
    const running = await sessionService.create({ workingDir: '/repo/r' });
    await sessionService.markRunning(running);
    const idle = await sessionService.create({ workingDir: '/repo/i' });
    const interrupted = await sessionService.create({ workingDir: '/repo/x' });
    await sessionService.markRunning(interrupted);
    await sessionService.markAllInterrupted();
    await sessionService.markRunning(interrupted);

    const affected = await sessionService.markAllInterrupted();
    expect(affected, '第二次恢复只重置新的 running（interrupted 不算 running）').toBe(1);
    const metas = (await sessionService.list(100, 0)).sessions;
    expect(metas.find((s) => s.id === running)?.lastRunStatus).toBe('interrupted');
    expect(metas.find((s) => s.id === idle)?.lastRunStatus).toBe('idle');
    expect(metas.find((s) => s.id === interrupted)?.lastRunStatus).toBe('interrupted');
  });

  it('恢复后可继续：interrupted 会话 markIdle 恢复正常（用户恢复使用）', async () => {
    const a = await sessionService.create({ workingDir: '/repo/a' });
    await sessionService.markRunning(a);
    simulateRestart();
    await sessionService.markAllInterrupted();

    await sessionService.markRunning(a);
    const running = (await sessionService.list(100, 0)).sessions.find((s) => s.id === a);
    expect(running?.lastRunStatus).toBe('running');
    await sessionService.markIdle(a);
    const idle = (await sessionService.list(100, 0)).sessions.find((s) => s.id === a);
    expect(idle?.lastRunStatus).toBe('idle');
  });

  it('幂等：无 running 残留时 markAllInterrupted 返回 0', async () => {
    const a = await sessionService.create({ workingDir: '/repo/a' });
    await sessionService.markRunning(a);
    await sessionService.markIdle(a);
    expect(await sessionService.markAllInterrupted()).toBe(0);
  });

  it('数据不丢：崩溃前追加的消息在恢复后完整', async () => {
    const a = await sessionService.create({
      workingDir: '/repo/a',
      messages: [makeMessage(0), makeMessage(1)],
    });
    await sessionService.markRunning(a);
    await sessionService.appendMessage({ sessionId: a, messages: [makeMessage(2)] });

    simulateRestart();
    await sessionService.markAllInterrupted();

    const detail = await sessionService.get(a);
    expect(detail.messages).toHaveLength(3);
    expect(detail.session.lastRunStatus).toBe('interrupted');
  });
});
