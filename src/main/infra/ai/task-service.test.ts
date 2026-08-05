// src/main/infra/ai/task-service.test.ts
// 任务状态机单测：创建/更新/列表/终端状态锁定（内存 DB）

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../storage/schema';
import { SCHEMA_SQL } from '../storage/schema-sql';
import { TaskKind, TaskService, TaskStatus } from './task-service';

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
import { SessionService } from '../storage/session-service';

describe('TaskService', () => {
  let sessionService: SessionService;

  beforeAll(() => {
    resetDb();
  });

  beforeEach(() => {
    resetDb();
    sessionService = new SessionService();
    vi.clearAllMocks();
  });

  async function createSession(): Promise<string> {
    return sessionService.create({
      workingDir: 'D:\\proj',
      title: undefined,
      messages: undefined,
    });
  }

  it('create：pending 状态 + 时间戳（DB 持久化）', async () => {
    const service = new TaskService();
    const sid = await createSession();
    const id = service.create(sid, TaskKind.AGENT, '子代理 general：分析代码');
    const task = service.get(id);
    expect(task).toMatchObject({
      sessionId: sid,
      kind: 'agent',
      status: 'pending',
      endTime: null,
    });
    expect(task?.startTime).toBeGreaterThan(0);
  });

  it('update：pending → running → completed（记录 endTime）', async () => {
    const service = new TaskService();
    const sid = await createSession();
    const id = service.create(sid, TaskKind.AGENT, '任务');
    expect(service.update(id, TaskStatus.RUNNING)).toBe(true);
    expect(service.get(id)?.status).toBe('running');
    expect(service.update(id, TaskStatus.COMPLETED)).toBe(true);
    expect(service.get(id)?.status).toBe('completed');
    expect(service.get(id)?.endTime).not.toBeNull();
  });

  it('update：终端状态锁定（completed 后不再改变）', async () => {
    const service = new TaskService();
    const sid = await createSession();
    const id = service.create(sid, TaskKind.AGENT, '任务');
    service.update(id, TaskStatus.COMPLETED);
    expect(service.update(id, TaskStatus.RUNNING)).toBe(false);
    expect(service.get(id)?.status).toBe('completed');
  });

  it('update：未知任务返回 false', () => {
    const service = new TaskService();
    expect(service.update('nonexistent', TaskStatus.RUNNING)).toBe(false);
  });

  it('list：会话过滤 + 创建时间倒序', async () => {
    const service = new TaskService();
    const s1 = await createSession();
    const s2 = await createSession();
    service.create(s1, TaskKind.AGENT, '任务 A');
    service.create(s2, TaskKind.SHELL, '任务 B');
    service.create(s1, TaskKind.AGENT, '任务 C');

    const s1Tasks = service.list(s1);
    expect(s1Tasks).toHaveLength(2);
    expect(s1Tasks.map((t) => t.description).sort()).toEqual(['任务 A', '任务 C']);

    const all = service.list();
    expect(all).toHaveLength(3);
  });

  it('持久化：新实例可读取已创建任务（跨实例）', async () => {
    const sid = await createSession();
    const id = new TaskService().create(sid, TaskKind.AGENT, '持久任务');
    // 新实例（同一 DB）可读
    const task = new TaskService().get(id);
    expect(task?.description).toBe('持久任务');
  });
});
