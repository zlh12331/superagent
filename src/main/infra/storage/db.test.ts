// src/main/infra/storage/db.test.ts
// db 单测：SQLite 初始化（真实 better-sqlite3 + 临时目录，drizzle sql API）
// ──────────────────────────────────────────────────────────────
// 2026-08-24 重构：迁移机制从手写 SCHEMA_SQL / MIGRATIONS 切换为
// drizzle-kit 迁移（schema.ts 单一真源）。原「双源一致性」与
// 「user_version 版本链」测试随机制退役，新增「约束生效」断言——
// CHECK / UNIQUE / 外键由迁移落库并被 SQLite 强制执行。
// ──────────────────────────────────────────────────────────────

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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

  it('initDb 热备份：原子落位 sessions-*.db、无 .tmp 残留、备份可校验', async () => {
    resetDb();
    initDb();
    const backupDir = join(tempDir, 'backups');

    // 备份以 void 异步发起（不阻断启动），轮询等待 rename 落定
    let names: string[] = [];
    for (let i = 0; i < 100; i++) {
      names = readdirSync(backupDir);
      if (names.some((n) => n.endsWith('.db'))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const backups = names.filter((n) => n.endsWith('.db'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    // 关键断言：失败的半成品只可能是 .db.tmp，不可混入 .db 恢复点；
    // 成功路径 rename 后不应留下任何 tmp
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);

    const backupFile = backups.sort().at(-1);
    if (backupFile === undefined) throw new Error('备份文件未生成');
    const backup = Database(join(backupDir, backupFile), { readonly: true });
    try {
      expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
      // 备份发生在迁移之后：表结构完整
      const tables = backup.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[];
      expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['sessions', 'messages']));
    } finally {
      backup.close();
    }
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
        'idx_messages_turn',
        'idx_prompts_role',
        'idx_token_usage_created_at',
        'idx_turns_session_seq',
        'idx_goals_session',
        'uq_turns_turn_id',
        'uq_messages_session_seq',
        'uq_turns_session_seq',
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

  it('触发器（0002）：非法 sessions.last_run_status UPDATE 被拒', () => {
    const db = initDb();
    raw(db)
      .prepare(
        "INSERT INTO sessions (id, title, created_at, updated_at, working_dir) VALUES ('s3', 't', 0, 0, '/w')",
      )
      .run();
    expect(() =>
      raw(db).prepare("UPDATE sessions SET last_run_status = 'bogus' WHERE id = 's3'").run(),
    ).toThrow(/CHECK constraint failed/i);
    // 合法值仍可写（崩溃恢复链路 markRunning/markInterrupted/idle 不受影响）
    raw(db).prepare("UPDATE sessions SET last_run_status = 'running' WHERE id = 's3'").run();
    const row = raw(db)
      .prepare("SELECT last_run_status AS lastRunStatus FROM sessions WHERE id = 's3'")
      .get() as { lastRunStatus: string };
    expect(row.lastRunStatus).toBe('running');
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

  it('唯一：同会话同 seq 的消息重复插入被拒（0003）', () => {
    const db = initDb();
    raw(db)
      .prepare(
        "INSERT INTO sessions (id, title, created_at, updated_at, working_dir) VALUES ('s4', 't', 0, 0, '/w')",
      )
      .run();
    raw(db)
      .prepare(
        "INSERT INTO messages (session_id, seq, role, content, created_at) VALUES ('s4', 0, 'user', 'x', 100)",
      )
      .run();
    // 同 (session_id, seq) 重试写入 → UNIQUE 拒绝（防并发/重试双行）
    expect(() =>
      raw(db)
        .prepare(
          "INSERT INTO messages (session_id, seq, role, content, created_at) VALUES ('s4', 0, 'user', 'y', 100)",
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/i);
    // 同会话不同 seq 不冲突（唯一是 (session_id, seq) 组合）
    expect(() =>
      raw(db)
        .prepare(
          "INSERT INTO messages (session_id, seq, role, content, created_at) VALUES ('s4', 1, 'user', 'z', 100)",
        )
        .run(),
    ).not.toThrow();
  });

  it('唯一：同会话同回合序号的 turns 重复插入被拒（0003）', () => {
    const db = initDb();
    raw(db)
      .prepare(
        "INSERT INTO sessions (id, title, created_at, updated_at, working_dir) VALUES ('s6', 't', 0, 0, '/w')",
      )
      .run();
    raw(db)
      .prepare(
        "INSERT INTO turns (turn_id, session_id, seq, model_id, status, created_at) VALUES ('u1', 's6', 0, 'm', 'completed', 100)",
      )
      .run();
    expect(() =>
      raw(db)
        .prepare(
          "INSERT INTO turns (turn_id, session_id, seq, model_id, status, created_at) VALUES ('u2', 's6', 0, 'm', 'completed', 100)",
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

// ── 老库升级（drizzle 增量迁移路径）────────────────────────
// 场景：手写 schema-sql.ts 时代建的老库（11 表 + 旧索引，无 CHECK / UNIQUE，
// 且无 __drizzle_migrations journal）。initDb 时应：
//   1. 0000 全量 IF NOT EXISTS 幂等跳过（不再因 "index already exists" 崩）
//   2. 0001_legacy_upgrade 数据保真重建 5 张表，补齐领域约束
//   3. 0002 ~ 0004 续跑（补 sessions 约束、会话内 seq UNIQUE、清理冗余索引）
//   4. journal 记录全部迁移（此后进入 drizzle 版本体系）
describe('老库升级（增量迁移）', () => {
  /** 旧手写 schema 的全部建表 + 索引 SQL（对齐已退役的 schema-sql.ts） */
  const LegacySchemaSql = `
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_message TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      working_dir TEXT NOT NULL DEFAULT '',
      last_run_status TEXT NOT NULL DEFAULT 'idle',
      pinned INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_id TEXT,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE prompts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER,
      reasoning_tokens INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      duration_ms INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE runtime_models (
      model_id TEXT PRIMARY KEY,
      provider_kind TEXT NOT NULL,
      base_url TEXT,
      display_name TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE skills (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      prompt TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'learned',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE cron_tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      expression TEXT NOT NULL,
      description TEXT NOT NULL,
      next_fire_at INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      start_time INTEGER NOT NULL,
      end_time INTEGER
    );
    CREATE TABLE goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      condition TEXT NOT NULL,
      status TEXT NOT NULL,
      iterations INTEGER NOT NULL DEFAULT 0,
      last_reason TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_messages_turn ON messages(turn_id);
    CREATE INDEX IF NOT EXISTS idx_prompts_role ON prompts(role);
    CREATE INDEX IF NOT EXISTS idx_token_usage_created_at ON token_usage(created_at);
    CREATE INDEX IF NOT EXISTS idx_turns_session_seq ON turns(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_goals_session ON goals(session_id);
  `;

  function raw(db: ReturnType<typeof initDb>): Database.Database {
    return (db as unknown as { $client: Database.Database }).$client;
  }

  it('旧 schema 库 → 数据保真 + 约束补齐 + journal 五条，重复 initDb 幂等', async () => {
    resetDb();
    closeDb();
    const legacyDir = mkdtempSync(join(tmpdir(), 'code-agent-db-legacy-v2-'));
    mockApp.getPath.mockReturnValue(legacyDir);
    try {
      // 构造旧手写 schema 老库 + 数据（messages/turns 等 FK 需先插 sessions）
      const lg = new Database(getDbPath());
      lg.pragma('foreign_keys = ON');
      lg.exec(LegacySchemaSql);
      lg.exec(`
        INSERT INTO sessions (id, title, created_at, updated_at, working_dir)
          VALUES ('legacy-session', 'Legacy', 100, 100, '/w');
        INSERT INTO messages (session_id, turn_id, seq, role, content, created_at)
          VALUES ('legacy-session', 'legacy-turn', 0, 'user', '老消息', 100);
        INSERT INTO turns (turn_id, session_id, seq, model_id, status, created_at)
          VALUES ('legacy-turn', 'legacy-session', 0, 'm', 'completed', 100);
        INSERT INTO skills (name, description, prompt, source, created_at)
          VALUES ('legacy-skill', 'd', 'p', 'learned', 100);
        INSERT INTO cron_tasks (id, session_id, expression, description, enabled, created_at)
          VALUES ('legacy-cron', 'legacy-session', '* * * * *', 'dc', 1, 100);
        INSERT INTO runtime_models (model_id, provider_kind, is_enabled, created_at)
          VALUES ('legacy-model', 'deepseek', 1, 100);
      `);
      lg.close();

      // 修复前：0000 CREATE INDEX（无 IF NOT EXISTS）会在既有同名索引处
      // 抛 "index already exists" 中断迁移 → initDb 崩。修复后应成功。
      const db = initDb();

      // 1) 数据保真（0001 重建表不丢数据）
      const msg = raw(db)
        .prepare("SELECT role, content FROM messages WHERE session_id = 'legacy-session'")
        .get() as { role: string; content: string };
      expect(msg).toEqual({ role: 'user', content: '老消息' });
      expect(
        raw(db).prepare("SELECT name FROM skills WHERE name = 'legacy-skill'").get(),
      ).toBeDefined();
      expect(
        raw(db).prepare("SELECT id FROM cron_tasks WHERE id = 'legacy-cron'").get(),
      ).toBeDefined();
      expect(
        raw(db)
          .prepare("SELECT model_id FROM runtime_models WHERE model_id = 'legacy-model'")
          .get(),
      ).toBeDefined();

      // 2) 约束补齐：非法 role 插入被 CHECK 拒绝（0001 重建后生效）
      expect(() =>
        raw(db)
          .prepare(
            "INSERT INTO messages (session_id, seq, role, content, created_at) VALUES ('legacy-session', 1, 'bogus', 'x', 0)",
          )
          .run(),
      ).toThrow(/CHECK constraint failed/i);

      // 3) UNIQUE 索引补齐：重复 turn_id 被拒
      expect(() =>
        raw(db)
          .prepare(
            "INSERT INTO turns (turn_id, session_id, seq, model_id, status, created_at) VALUES ('legacy-turn', 'legacy-session', 1, 'm', 'completed', 100)",
          )
          .run(),
      ).toThrow(/UNIQUE constraint failed/i);

      // 4) journal 记录全部迁移（进入 drizzle 版本体系：0000 ~ 0004）
      const migs = raw(db).prepare('SELECT hash FROM __drizzle_migrations').all();
      expect(migs).toHaveLength(5);

      // 5) 幂等：重复 initDb 不重跑迁移、不崩
      closeDb();
      resetDb();
      expect(() => initDb()).not.toThrow();

      // 等待异步热备份日志落定（避免 teardown 竞态）
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      closeDb();
      mockApp.getPath.mockReturnValue(tempDir);
      try {
        rmSync(legacyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // 句柄未释放时跳过清理（临时目录由系统回收）
      }
    }
  });

  it('新库：0000 ~ 0004 全执行（journal 五条），约束齐全', async () => {
    resetDb();
    closeDb();
    const freshDir = mkdtempSync(join(tmpdir(), 'code-agent-db-fresh-v2-'));
    mockApp.getPath.mockReturnValue(freshDir);
    try {
      const db = initDb();
      const migs = raw(db).prepare('SELECT hash FROM __drizzle_migrations').all();
      expect(migs).toHaveLength(5);
      // 约束仍生效（0001 重建未破坏 0000 语义）
      expect(() =>
        raw(db)
          .prepare(
            "INSERT INTO messages (session_id, seq, role, content, created_at) VALUES ('s', 0, 'bogus', 'x', 0)",
          )
          .run(),
      ).toThrow(/CHECK constraint failed/i);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      closeDb();
      mockApp.getPath.mockReturnValue(tempDir);
      try {
        rmSync(freshDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // 句柄未释放时跳过清理
      }
    }
  });
});
