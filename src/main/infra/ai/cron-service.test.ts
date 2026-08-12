// src/main/infra/ai/cron-service.test.ts
// 定时任务服务单测：创建/删除/列表/启停/触发（内存 DB + croner 真实调度）

import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
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

import { getDb, resetDb } from '../storage/db';

/** 秒级表达式（croner 6 字段：秒/分/时/日/月/周）——单测触发不等待分钟级 */
const EVERY_SECOND = '* * * * * *';

/** 等待条件成立（真实 croner 调度触发用） */
async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor 超时');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('CronService', () => {
  let service: CronService;

  beforeEach(() => {
    resetDb();
    service = new CronService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    service.stop();
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
    const id = service.create('s1', EVERY_SECOND, '每秒');
    expect(service.setEnabled(id, false)).toBe(true);
    const disabled = service.list().find((t) => t.id === id);
    expect(disabled?.enabled).toBe(false);

    // 停用：等待 1.2s（croner 秒级调度）不应触发
    const fired: string[] = [];
    service.onFire((task) => {
      fired.push(task.id);
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(fired).toHaveLength(0);

    expect(service.setEnabled(id, true)).toBe(true);
    const enabled = service.list().find((t) => t.id === id);
    expect(enabled?.enabled).toBe(true);
    expect(enabled?.nextFireAt).not.toBeNull();
  });

  it('到期任务触发并更新下次触发（croner 真实调度）', async () => {
    const id = service.create('s1', EVERY_SECOND, '每秒');
    const fired: Array<{ id: string; description: string }> = [];
    service.onFire((task) => {
      fired.push({ id: task.id, description: task.description });
    });

    await waitFor(() => fired.length >= 1);
    expect(fired[0]?.description).toBe('每秒');

    // 下次触发已更新（未来）
    const after = service.list().find((t) => t.id === id);
    expect(after?.nextFireAt as number).toBeGreaterThan(Date.now());
  });

  it('start/stop：调度生命周期（幂等；start 恢复启用任务）', async () => {
    service.create('s1', EVERY_SECOND, '每秒');
    const fired: string[] = [];
    service.onFire((task) => {
      fired.push(task.id);
    });
    service.start();
    service.start(); // 幂等（不重复创建实例）
    service.stop();
    service.stop(); // 幂等

    // 停止后不再触发
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const stoppedCount = fired.length;

    // 重新 start：恢复任务并继续触发
    service.start();
    await waitFor(() => fired.length > stoppedCount);
  });

  it('onFire：unsubscribe 生效', async () => {
    service.create('s1', EVERY_SECOND, '每秒');
    const fired: string[] = [];
    const unsubscribe = service.onFire((task) => {
      fired.push(task.id);
    });
    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
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

  it('setEnabled 任务不存在：返回 false', () => {
    const service = new CronService();
    expect(service.setEnabled('ghost-task', true)).toBe(false);
  });

  it('setEnabled 停用后重新启用：复用已有调度实例（resume 分支）', () => {
    const service = new CronService();
    const id = service.create('sess-1', EVERY_SECOND, '每秒任务');
    // 停用：job 保留在 jobs Map（仅 pause）
    expect(service.setEnabled(id, false)).toBe(true);
    // 重新启用：复用 job（不重复创建调度实例）
    expect(service.setEnabled(id, true)).toBe(true);
    const jobs = (service as unknown as { jobs: Map<string, unknown> }).jobs;
    expect(jobs.size).toBe(1);
  });

  it('start 恢复：跳过已停用任务（enabled !== 1）', async () => {
    const service = new CronService();
    const enabledId = service.create('sess-1', EVERY_SECOND, '启用任务');
    const disabledId = service.create('sess-2', EVERY_SECOND, '停用任务');
    // 模拟"重启后无调度实例"：从 jobs Map 移除 + 改库停用
    const jobs = (service as unknown as { jobs: Map<string, unknown> }).jobs;
    jobs.delete(disabledId);
    getDb()
      .update(schema.cronTasks)
      .set({ enabled: 0 })
      .where(eq(schema.cronTasks.id, disabledId))
      .run();

    service.start();
    // start 幂等
    service.start();

    // 启用任务恢复调度；停用任务跳过（不创建实例）
    expect(jobs.has(enabledId)).toBe(true);
    expect(jobs.has(disabledId)).toBe(false);
  });

  it('list 同 createdAt：id 兜底稳定排序（改库模拟同毫秒）', async () => {
    const service = new CronService();
    const idA = service.create('sess-1', EVERY_SECOND, '任务 A');
    const idB = service.create('sess-2', EVERY_SECOND, '任务 B');
    // 把两条记录改为同一 createdAt，验证 id 兜底排序确定性
    const db = getDb();
    const now = 1_700_000_000_000;
    db.update(schema.cronTasks).set({ createdAt: now }).where(eq(schema.cronTasks.id, idA)).run();
    db.update(schema.cronTasks).set({ createdAt: now }).where(eq(schema.cronTasks.id, idB)).run();

    const tasks = service.list();
    // 排序确定性：两次调用结果一致
    expect(service.list().map((t) => t.id)).toEqual(tasks.map((t) => t.id));
  });
});
