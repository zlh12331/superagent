// src/main/infra/ai/tools/task-tools.test.ts
// 任务工具单测：task_create / task_update / task_list 真实执行（内存 DB）

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../../storage/schema';
import { SCHEMA_SQL } from '../../storage/schema-sql';
import { SessionService } from '../../storage/session-service';
import { createTaskCreateTool } from './task-create.tool';
import { createTaskListTool } from './task-list.tool';
import { createTaskUpdateTool } from './task-update.tool';
import type { ToolContext } from './tool';

// mock getDb：内存数据库（建表 SQL 单一真源）
function createInMemoryDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  sqlite.exec(SCHEMA_SQL);
  return { db, sqlite };
}

vi.mock('../../storage/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../storage/db')>();
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

import { resetDb } from '../../storage/db';

describe('任务工具', () => {
  let sessionService: SessionService;

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

  function makeCtx(sessionId: string): ToolContext {
    return {
      sessionId,
      workingDir: 'D:\\proj',
      userPrompt: undefined,
    } as unknown as ToolContext;
  }

  it('task_create：创建任务并返回 taskId', async () => {
    const sid = await createSession();
    const tool = createTaskCreateTool();
    const result = await tool.execute({ description: '重构模块 A' }, makeCtx(sid));
    expect(result.title).toContain('任务已创建');
    expect(result.output).toContain('任务创建成功');
  });

  it('task_update：状态流转 + 终端锁定', async () => {
    const sid = await createSession();
    const createTool = createTaskCreateTool();
    const created = await createTool.execute({ description: '任务 B' }, makeCtx(sid));
    const taskId = created.output.match(/任务创建成功：([a-f0-9-]+)/)?.[1];
    expect(taskId).toBeDefined();

    const updateTool = createTaskUpdateTool();
    const running = await updateTool.execute(
      { taskId: taskId as string, status: 'running' },
      makeCtx(sid),
    );
    expect(running.title).toContain('running');

    const done = await updateTool.execute(
      { taskId: taskId as string, status: 'completed' },
      makeCtx(sid),
    );
    expect(done.title).toContain('completed');

    // 终端状态锁定：再更新失败
    const locked = await updateTool.execute(
      { taskId: taskId as string, status: 'cancelled' },
      makeCtx(sid),
    );
    expect(locked.title).toContain('更新失败');
  });

  it('task_update：未知任务失败', async () => {
    const sid = await createSession();
    const tool = createTaskUpdateTool();
    const result = await tool.execute({ taskId: 'nope', status: 'running' }, makeCtx(sid));
    expect(result.title).toContain('失败');
  });

  it('task_list：列出当前会话任务（倒序）', async () => {
    const sid = await createSession();
    const createTool = createTaskCreateTool();
    await createTool.execute({ description: '任务 1' }, makeCtx(sid));
    await createTool.execute({ description: '任务 2' }, makeCtx(sid));

    const listTool = createTaskListTool();
    const result = await listTool.execute({}, makeCtx(sid));
    expect(result.title).toContain('2 条');
    expect(result.output).toContain('任务 1');
    expect(result.output).toContain('任务 2');
  });

  it('task_list：空会话返回占位', async () => {
    const sid = await createSession();
    const listTool = createTaskListTool();
    const result = await listTool.execute({}, makeCtx(sid));
    expect(result.output).toContain('暂无任务');
  });
});
