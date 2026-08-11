// tests/integration/crash-recovery.test.ts
// 集成测试：崩溃恢复链路（进程异常退出 → 重启 → 会话状态机归位）
// ──────────────────────────────────────────────────────────────
// 验证目标（对齐 index.ts recoverFromCrash 的启动恢复语义）：
// 1. 崩溃恢复主链路：running 残留 → markAllInterrupted → 全部归位 interrupted
// 2. 只重置 running：idle / interrupted 会话不受影响（不误伤正常会话）
// 3. 恢复后可继续：interrupted 会话 markIdle 后恢复正常使用
// 4. 幂等：重复恢复安全（重启两次不产生副作用）
// 5. 数据不丢：崩溃前追加的消息在恢复后完整（持久化不受状态机影响）
//
// 基础设施：内存 SQLite（建表 SQL 单一真源 SCHEMA_SQL），真实 SessionService。
// 模拟崩溃 = 不调用 markIdle，直接重建服务实例（进程内状态丢失）；
// DB 保持不重置（真实崩溃后 SQLite 文件仍在，重启后数据可恢复）——
// 这是"崩溃恢复"测试的语义核心：恢复依赖持久化状态，不依赖进程内存。
// ──────────────────────────────────────────────────────────────

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../../src/main/infra/storage/schema';
import { SCHEMA_SQL } from '../../src/main/infra/storage/schema-sql';

// 内存 DB 注入（与 session-goal.test.ts 同模式：环境隔离，非业务 mock）
function createInMemoryDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  sqlite.exec(SCHEMA_SQL);
  return { db, sqlite };
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
    resetDb(); // 用例间隔离：全新内存 DB
    sessionService = new SessionService();
  });

  /** 模拟进程重启：仅重建服务实例（进程内状态丢失），DB 保持（真实持久化语义） */
  function simulateRestart(): void {
    sessionService = new SessionService();
  }

  it('主链路：running 残留 → 重启 → markAllInterrupted 全部归位', async () => {
    // 模拟崩溃前：会话 A 回合进行中（未 markIdle = 进程异常退出）
    const a = await sessionService.create({ workingDir: '/repo/a' });
    await sessionService.markRunning(a);
    // 会话 B 正常结束（markIdle 已调用 = 正常退出）
    const b = await sessionService.create({ workingDir: '/repo/b' });
    await sessionService.markRunning(b);
    await sessionService.markIdle(b);

    // 重启后：启动恢复（index.ts recoverFromCrash 的语义）
    simulateRestart();
    const affected = await sessionService.markAllInterrupted();

    expect(affected, '只有 running 残留被重置（1 个）').toBe(1);
    const aMeta = (await sessionService.list(100, 0)).sessions.find((s) => s.id === a);
    const bMeta = (await sessionService.list(100, 0)).sessions.find((s) => s.id === b);
    expect(aMeta?.lastRunStatus).toBe('interrupted'); // 崩溃会话 → interrupted
    expect(bMeta?.lastRunStatus).toBe('idle'); // 正常会话不受影响
  });

  it('只重置 running：interrupted/idle 混合状态不被误伤', async () => {
    const running = await sessionService.create({ workingDir: '/repo/r' });
    await sessionService.markRunning(running);
    const idle = await sessionService.create({ workingDir: '/repo/i' });
    const interrupted = await sessionService.create({ workingDir: '/repo/x' });
    await sessionService.markRunning(interrupted);
    await sessionService.markAllInterrupted(); // 第一次恢复
    // 再模拟第二次崩溃：新增一个 running，旧的 interrupted 保持
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
    // 崩溃 + 重启 + 启动恢复
    simulateRestart();
    await sessionService.markAllInterrupted();

    // 用户点击恢复 → 重新开始回合
    await sessionService.markRunning(a);
    const running = (await sessionService.list(100, 0)).sessions.find((s) => s.id === a);
    expect(running?.lastRunStatus).toBe('running'); // 可从 interrupted 重新进入 running
    await sessionService.markIdle(a);
    const idle = (await sessionService.list(100, 0)).sessions.find((s) => s.id === a);
    expect(idle?.lastRunStatus).toBe('idle'); // 正常结束
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

    // 崩溃 + 重启 + 恢复
    simulateRestart();
    await sessionService.markAllInterrupted();

    const detail = await sessionService.get(a);
    expect(detail.messages).toHaveLength(3); // 消息持久化不受状态机影响
    expect(detail.session.lastRunStatus).toBe('interrupted');
  });
});
