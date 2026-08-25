// src/main/infra/storage/db.test.ts
// db 单测：SQLite 初始化（真实 better-sqlite3 + 临时目录，drizzle sql API）
// ──────────────────────────────────────────────────────────────
// 2026-08-24 重构：迁移机制从手写 SCHEMA_SQL / MIGRATIONS 切换为
// drizzle-kit 迁移（schema.ts 单一真源）。原「双源一致性」与
// 「user_version 版本链」测试随机制退役，新增「约束生效」断言——
// CHECK / UNIQUE / 外键由迁移落库并被 SQLite 强制执行。
// ──────────────────────────────────────────────────────────────

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockApp } = vi.hoisted(() => ({
  mockApp: { getPath: vi.fn(() => '/tmp/db-test') },
}));

vi.mock('electron', () => ({
  app: {
    ...mockApp,
    // initDb 的 resolveMigrationsDir 需要：dev 环境指向项目根 drizzle/
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
}));

// mock logger：initDb 的异步热备份日志不输出到 console，
// 避免 worker 关闭时 onUserConsoleLog pending 触发 EnvironmentTeardownError
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { closeDb, getDbPath, initDb, resetDb } from './db';

let tempDir: string;

describe('db', () => {
  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'code-agent-db-test-'));
    mockApp.getPath.mockReturnValue(tempDir);
  });

  afterAll(async () => {
    // 等待 initDb 触发的异步热备份日志落定，避免其在 vitest worker 关闭后
    // 到达触发 EnvironmentTeardownError（onUserConsoleLog pending）
    await new Promise((resolve) => setTimeout(resolve, 300));
    closeDb();
    // WAL 文件可能仍被短暂占用；清理失败不阻塞测试结果（Windows 句柄延迟释放）
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // 句柄未释放时跳过清理（临时目录由系统回收）
    }
  });

  beforeEach(() => {
    resetDb();
  });

  it('getDbPath：指向 userData 下的 sessions.db', () => {
    expect(getDbPath()).toBe(join(tempDir, 'sessions.db'));
  });

  it('initDb：创建数据库并建表（全部 11 张表）', () => {
    const db = initDb();
    const rows = db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type='table'`);
    const names = rows.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'sessions',
        'messages',
        'prompts',
        'token_usage',
        'turns',
        'runtime_models',
        'goals',
        'tasks',
        'cron_tasks',
        'skills',
        'app_settings',
      ]),
    );
  });

  it('initDb：幂等（重复调用返回同一实例）', () => {
    expect(initDb()).toBe(initDb());
  });

  it('initDb：索引与唯一约束已创建', () => {
    resetDb();
    const db = initDb();
    const rows = db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type='index'`);
    const names = rows.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'idx_sessions_updated_at',
        'idx_messages_session_seq',
        'idx_messages_turn',
        'idx_prompts_role',
        'idx_token_usage_created_at',
        'idx_turns_session_seq',
        'idx_goals_session',
        'uq_turns_turn_id',
      ]),
    );
  });

  it('数据库文件已创建在临时目录', () => {
    initDb();
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    expect(existsSync(join(tempDir, 'sessions.db'))).toBe(true);
  });
});

// ── 约束生效（drizzle 迁移落库后被 SQLite 强制执行）──
describe('领域约束生效', () => {
  /** 底层 better-sqlite3 连接（错误为原生 SqliteError，message 含约束名） */
  function raw(db: ReturnType<typeof initDb>): Database.Database {
    return (db as unknown as { $client: Database.Database }).$client;
  }

  beforeEach(() => {
    resetDb();
  });

  it('CHECK：非法 messages.role 插入被拒', () => {
    const db = initDb();
    expect(() =>
      raw(db)
        .prepare(
          "INSERT INTO messages (session_id, seq, role, content, created_at) VALUES ('s1', 0, 'bogus', 'x', 0)",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('CHECK：非法 sessions.last_run_status 插入被拒', () => {
    const db = initDb();
    expect(() =>
      raw(db)
        .prepare(
          "INSERT INTO sessions (id, title, created_at, updated_at, working_dir, last_run_status) VALUES ('s1', 't', 0, 0, '/w', 'unknown')",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('CHECK：非法 skills.source 插入被拒', () => {
    const db = initDb();
    expect(() =>
      raw(db)
        .prepare(
          "INSERT INTO skills (name, description, prompt, source, created_at) VALUES ('x', 'd', 'p', 'hacked', 100)",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('UNIQUE：turns.turn_id 重复插入被拒', () => {
    const db = initDb();
    raw(db)
      .prepare(
        "INSERT INTO sessions (id, title, created_at, updated_at, working_dir) VALUES ('s1', 't', 0, 0, '/w')",
      )
      .run();
    raw(db)
      .prepare(
        "INSERT INTO turns (turn_id, session_id, seq, model_id, status, created_at) VALUES ('t1', 's1', 0, 'm', 'completed', 100)",
      )
      .run();
    expect(() =>
      raw(db)
        .prepare(
          "INSERT INTO turns (turn_id, session_id, seq, model_id, status, created_at) VALUES ('t1', 's1', 1, 'm', 'completed', 100)",
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it('外键：孤儿 messages（session 不存在）插入被拒', () => {
    const db = initDb();
    expect(() =>
      raw(db)
        .prepare(
          "INSERT INTO messages (session_id, seq, role, content, created_at) VALUES ('no-such-session', 0, 'user', 'x', 0)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it('外键级联：删除会话级联清理 messages/turns/goals', () => {
    const db = initDb();
    raw(db)
      .prepare(
        "INSERT INTO sessions (id, title, created_at, updated_at, working_dir) VALUES ('s2', 't', 0, 0, '/w')",
      )
      .run();
    raw(db)
      .prepare(
        "INSERT INTO messages (session_id, seq, role, content, created_at) VALUES ('s2', 0, 'user', 'x', 0)",
      )
      .run();
    raw(db)
      .prepare(
        "INSERT INTO turns (turn_id, session_id, seq, model_id, status, created_at) VALUES ('t2', 's2', 0, 'm', 'completed', 100)",
      )
      .run();
    raw(db)
      .prepare(
        "INSERT INTO goals (session_id, condition, status, created_at) VALUES ('s2', 'cond', 'active', 100)",
      )
      .run();
    raw(db).prepare("DELETE FROM sessions WHERE id = 's2'").run();
    const count = (table: string) =>
      raw(db).prepare(`SELECT COUNT(*) as c FROM ${table} WHERE session_id = 's2'`).get() as {
        c: number;
      };
    expect(count('messages').c).toBe(0);
    expect(count('turns').c).toBe(0);
    expect(count('goals').c).toBe(0);
  });
});
