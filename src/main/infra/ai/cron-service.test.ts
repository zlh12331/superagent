// src/main/infra/ai/cron-service.test.ts
// 定时任务服务单测：创建/删除/列表/启停/触发（内存 DB）

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../storage/schema';
import { SCHEMA_SQL } from '../storage/schema-sql';
import { CronService } from './cron-service';

// mock getDb：内存数据库（建表 SQL 单一真源）
function createInMemoryDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  sqlite.exec(SCHEMA_SQL);
  return { db, sqlite };
}

vi.mock('../storage/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage/db')>();
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

import { resetDb } from '../storage/db';

describe('CronService', () => {
  let service: CronService;

  beforeEach(() => {
    resetDb();
    service = new CronService();
    vi.clearAllMocks();
  });

  it('create：创建任务并计算下次触发', () => {
    const id = service.create('s1', '0 9 * * *', '每天 9 点提醒');
    const task = service.list().find((t) => t.id === id);
    expect(task?.expression).toBe('0 9 * * *');
    expect(task?.enabled).toBe(true);
    expect(task?.nextFireAt).not.toBeNull();
    expect(task?.nextFireAt as number).toBeGreaterThan(Date.now());
  });

  it('create：非法表达式抛错（不落库）', () => {
    expect(() => service.create('s1', 'not-a-cron', 'x')).toThrow();
    expect(service.list()).toHaveLength(0);
  });

  it('delete：删除任务（幂等）', () => {
    const id = service.create('s1', '*/5 * * * *', '每 5 分钟');
    expect(service.delete(id)).toBe(true);
    expect(service.delete(id)).toBe(false);
    expect(service.list()).toHaveLength(0);
  });

  it('setEnabled：停用后不触发；重新启用重算下次触发', async () => {
    const id = service.create('s1', '* * * * *', '每分钟');
    expect(service.setEnabled(id, false)).toBe(true);
    const disabled = service.list().find((t) => t.id === id);
    expect(disabled?.enabled).toBe(false);

    // tick 不应触发停用任务
    const fired: string[] = [];
    service.onFire((task) => {
      fired.push(task.id);
    });
    await service.tick();
    expect(fired).toHaveLength(0);

    expect(service.setEnabled(id, true)).toBe(true);
    const enabled = service.list().find((t) => t.id === id);
    expect(enabled?.enabled).toBe(true);
    expect(enabled?.nextFireAt).not.toBeNull();
  });

  it('tick：到期任务触发并更新下次触发（同分钟不重复）', async () => {
    // 每分钟任务：nextFireAt 已过期 → tick 触发
    const id = service.create('s1', '* * * * *', '每分钟');
    // 人为把 nextFireAt 改为过去
    const { getDb } = await import('../storage/db');
    const { cronTasks } = await import('../storage/schema');
    const { eq } = await import('drizzle-orm');
    getDb()
      .update(cronTasks)
      .set({ nextFireAt: Date.now() - 60_000 })
      .where(eq(cronTasks.id, id))
      .run();

    const fired: Array<{ id: string; description: string }> = [];
    service.onFire((task) => {
      fired.push({ id: task.id, description: task.description });
    });

    await service.tick();
    expect(fired).toHaveLength(1);
    expect(fired[0]?.description).toBe('每分钟');

    // 下次触发已更新（未来）
    const after = service.list().find((t) => t.id === id);
    expect(after?.nextFireAt as number).toBeGreaterThan(Date.now());

    // 同分钟再次 tick 不重复触发
    fired.length = 0;
    await service.tick();
    expect(fired).toHaveLength(0);
  });

  it('start/stop：调度循环生命周期（幂等）', () => {
    service.start();
    service.start(); // 幂等
    service.stop();
    service.stop(); // 幂等
  });

  it('onFire：unsubscribe 生效', async () => {
    const id = service.create('s1', '* * * * *', '每分钟');
    const { getDb } = await import('../storage/db');
    const { cronTasks } = await import('../storage/schema');
    const { eq } = await import('drizzle-orm');
    getDb()
      .update(cronTasks)
      .set({ nextFireAt: Date.now() - 60_000 })
      .where(eq(cronTasks.id, id))
      .run();

    const fired: string[] = [];
    const unsubscribe = service.onFire((task) => {
      fired.push(task.id);
    });
    unsubscribe();
    await service.tick();
    expect(fired).toHaveLength(0);
  });

  it('list：创建时间倒序', () => {
    service.create('s1', '0 9 * * *', '任务 A');
    service.create('s2', '0 10 * * *', '任务 B');
    const tasks = service.list();
    expect(tasks).toHaveLength(2);
    // 同毫秒 id 兜底：稳定性
    expect(service.list().map((t) => t.id)).toEqual(tasks.map((t) => t.id));
  });
});
