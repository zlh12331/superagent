// src/main/infra/storage/db.test.ts
// db 单测：SQLite 初始化（真实 better-sqlite3 + 临时目录，drizzle sql API）
// ──────────────────────────────────────────────────────────────
// 2026-08-24 重构：迁移机制从手写 SCHEMA_SQL / MIGRATIONS 切换为
// drizzle-kit 迁移（schema.ts 单一真源）。原「双源一致性」与
// 「user_version 版本链」测试随机制退役，新增「约束生效」断言——
// CHECK / UNIQUE / 外键由迁移落库并被 SQLite 强制执行。
// ──────────────────────────────────────────────────────────────

import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
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

import { logger } from '../../utils/logger';
import { closeDb, getDbPath, initDb, reclaimFreePages, resetDb } from './db';
import { SessionService } from './session-service';

let tempDir: string;

describe('db', () => {
  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'code-agent-db-test-'));
    mockApp.getPath.mockReturnValue(tempDir);
  });

  afterAll(async () => {
    await closeDb();
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

  it('initDb：完整性校验未通过时跳过启动备份（保护既有健康恢复点）', async () => {
    const isolatedDir = mkdtempSync(join(tempDir, 'integrity-'));
    mockApp.getPath.mockReturnValue(isolatedDir);
    const backupDir = join(isolatedDir, 'backups');
    const proto = Database.prototype as unknown as {
      pragma(this: unknown, sql: string, opts?: unknown): unknown;
    };
    const originalPragma = proto.pragma;
    const listDbs = () =>
      readdirSync(backupDir)
        .filter((n) => n.endsWith('.db'))
        .sort();

    try {
      // 基线：正常库确实会产出备份，用于证明"无新备份"不是备份通道本身失效
      resetDb();
      initDb();
      let baseline: string[] = [];
      for (let i = 0; i < 100; i++) {
        baseline = listDbs();
        if (baseline.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(baseline).toHaveLength(1);
      await closeDb();

      // 基础设施边界 stub：仅让启动完整性探测返回损坏结果，其余 pragma 透传
      proto.pragma = function (this: unknown, sql: string, opts?: unknown): unknown {
        if (sql.trim().toLowerCase().startsWith('quick_check')) {
          return 'database disk image is malformed';
        }
        return originalPragma.call(this, sql, opts);
      };
      const warnMock = vi.mocked(logger.warn);
      warnMock.mockClear();

      resetDb();
      initDb();
      // 备份以 void 异步发起，等待足够时间确认未落盘
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(listDbs()).toEqual(baseline);
      expect(readdirSync(backupDir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
      expect(warnMock).toHaveBeenCalledWith({}, expect.stringContaining('跳过启动备份'));
    } finally {
      proto.pragma = originalPragma;
      await closeDb();
      resetDb();
      mockApp.getPath.mockReturnValue(tempDir);
    }
  });

  it('closeDb：等待在途启动备份落地后才关闭连接（不产出截断备份）', async () => {
    const isolatedDir = mkdtempSync(join(tempDir, 'drain-'));
    mockApp.getPath.mockReturnValue(isolatedDir);
    const backupDir = join(isolatedDir, 'backups');
    const errorMock = vi.mocked(logger.error);
    errorMock.mockClear();

    try {
      resetDb();
      initDb();
      // 此刻 sqlite.backup 仍在途；closeDb 必须先 drain 再关连接
      await closeDb();

      // 不做轮询即应看到完整备份——证明 closeDb 真的等待过，而非关在备份中途
      const names = readdirSync(backupDir);
      const backups = names.filter((n) => n.endsWith('.db'));
      const [backupFile] = backups;
      expect(backups).toHaveLength(1);
      expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
      if (backupFile === undefined) throw new Error('备份文件未生成');
      // 修复前的失败形态：备份打在已关闭的连接上
      expect(errorMock).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('数据库备份失败'),
      );

      const backup = Database(join(backupDir, backupFile), { readonly: true });
      try {
        expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
      } finally {
        backup.close();
      }
    } finally {
      resetDb();
      mockApp.getPath.mockReturnValue(tempDir);
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
        'idx_token_usage_session_id',
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

  it('旧 schema 库 → 数据保真 + 约束补齐 + journal 六条，重复 initDb 幂等', async () => {
    resetDb();
    await closeDb();
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

      // 4) journal 记录全部迁移（进入 drizzle 版本体系：0000 ~ 0005）
      const migs = raw(db).prepare('SELECT hash FROM __drizzle_migrations').all();
      expect(migs).toHaveLength(6);

      // 5) 幂等：重复 initDb 不重跑迁移、不崩
      await closeDb();
      resetDb();
      expect(() => initDb()).not.toThrow();
    } finally {
      await closeDb();
      mockApp.getPath.mockReturnValue(tempDir);
      try {
        rmSync(legacyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // 句柄未释放时跳过清理（临时目录由系统回收）
      }
    }
  });

  it('新库：0000 ~ 0005 全执行（journal 六条），约束齐全', async () => {
    resetDb();
    await closeDb();
    const freshDir = mkdtempSync(join(tmpdir(), 'code-agent-db-fresh-v2-'));
    mockApp.getPath.mockReturnValue(freshDir);
    try {
      const db = initDb();
      const migs = raw(db).prepare('SELECT hash FROM __drizzle_migrations').all();
      expect(migs).toHaveLength(6);
      // 约束仍生效（0001 重建未破坏 0000 语义）
      expect(() =>
        raw(db)
          .prepare(
            "INSERT INTO messages (session_id, seq, role, content, created_at) VALUES ('s', 0, 'bogus', 'x', 0)",
          )
          .run(),
      ).toThrow(/CHECK constraint failed/i);
    } finally {
      await closeDb();
      mockApp.getPath.mockReturnValue(tempDir);
      try {
        rmSync(freshDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // 句柄未释放时跳过清理
      }
    }
  });
});

// ── 空间回收（SQLite 磁盘占用）────────────────────────────
// 缺陷回归：auto_vacuum=NONE（SQLite 默认）下 DELETE 只把页放进 freelist，
// 文件永不缩小；且 `PRAGMA incremental_vacuum` 在该模式下是空操作
// （实测 20000 行删掉 90% 后文件仍 82.47MB、freelist 9016、freed_pages=0）。
// 修复分两步：initDb 一次性把库转成 INCREMENTAL（必须跟一次真实 VACUUM 才生效），
// 删除路径再调 reclaimFreePages() 归还空闲页 + WAL checkpoint。
// 本组用真实文件库跑生产删除路径，断言「磁盘占用确实下降」；并保留未转换库
// 的对照组——没有对照组，断言在修复被回退后仍可能恒真。
describe('空间回收（SQLite 磁盘占用）', () => {
  /** 制造足量可回收页：4000 行 × 2KB ≈ 8MB ≈ 2000 页，明显高于回收阈值 */
  const BulkRows = 4000;
  const BulkPayload = 'x'.repeat(2000);
  /** 断言用最小归还页数：远小于实际可回收量，但足以证明回收真的发生了 */
  const MinFreedPages = 1000;

  const service = new SessionService();

  function raw(db: ReturnType<typeof initDb>): Database.Database {
    return (db as unknown as { $client: Database.Database }).$client;
  }

  function pragmaNumber(sqlite: Database.Database, statement: string): number {
    return Number(sqlite.pragma(statement, { simple: true }));
  }

  /** 把 WAL 落回主库后再测占用：不 checkpoint 时字节数含 WAL，前后不可比 */
  function footprint(sqlite: Database.Database): { pages: number; bytes: number } {
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    return {
      pages: pragmaNumber(sqlite, 'page_count'),
      bytes: statSync(getDbPath()).size,
    };
  }

  function seedSession(sqlite: Database.Database, id: string): void {
    sqlite
      .prepare(
        'INSERT INTO sessions (id, title, created_at, updated_at, working_dir)' +
          " VALUES (?, 't', 100, 100, '/w')",
      )
      .run(id);
  }

  /** 灌入大消息（事务内批量插入，seq 连续以满足 (session_id, seq) UNIQUE） */
  function seedBulkMessages(sqlite: Database.Database, sessionId: string): void {
    const insert = sqlite.prepare(
      'INSERT INTO messages (session_id, seq, role, content, created_at)' +
        " VALUES (?, ?, 'user', ?, 100)",
    );
    const insertAll = sqlite.transaction((rows: number) => {
      for (let i = 0; i < rows; i++) insert.run(sessionId, i, BulkPayload);
    });
    insertAll(BulkRows);
  }

  /** token_usage 全是整型列，靠 model_id 撑体积；created_at=1 落在统计窗口外 */
  function seedBulkUsage(sqlite: Database.Database, sessionId: string): void {
    const insert = sqlite.prepare(
      'INSERT INTO token_usage' +
        ' (session_id, model_id, input_tokens, output_tokens, total_tokens, created_at)' +
        ' VALUES (?, ?, 1, 1, 2, 1)',
    );
    const insertAll = sqlite.transaction((rows: number) => {
      for (let i = 0; i < rows; i++) insert.run(sessionId, BulkPayload);
    });
    insertAll(BulkRows);
  }

  /** 隔离文件库：重定向 userData，结束后关连接 + 还原 + 清理临时目录 */
  async function withIsolatedDb(
    prefix: string,
    run: (dir: string) => void | Promise<void>,
  ): Promise<void> {
    await closeDb();
    resetDb();
    const dir = mkdtempSync(join(tmpdir(), `code-agent-${prefix}-`));
    mockApp.getPath.mockReturnValue(dir);
    try {
      await run(dir);
    } finally {
      await closeDb();
      resetDb();
      mockApp.getPath.mockReturnValue(tempDir);
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // 句柄未释放时跳过清理（临时目录由系统回收）
      }
    }
  }

  it('对照组：未转换的库（auto_vacuum=NONE）删除后 incremental_vacuum 归还不了任何页', async () => {
    await withIsolatedDb('vac-none-', () => {
      // 刻意不走 initDb：对照组必须保持 SQLite 默认 auto_vacuum=NONE
      const sqlite = new Database(getDbPath());
      try {
        sqlite.pragma('journal_mode = WAL');
        sqlite.exec(
          'CREATE TABLE messages (' +
            'session_id TEXT NOT NULL, seq INTEGER NOT NULL,' +
            'role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)',
        );
        seedBulkMessages(sqlite, 'ctrl');
        const before = footprint(sqlite);

        sqlite.exec("DELETE FROM messages WHERE session_id = 'ctrl'");
        // 前提：确实存在大量可回收页，否则「没缩小」毫无意义
        expect(pragmaNumber(sqlite, 'auto_vacuum')).toBe(0);
        expect(pragmaNumber(sqlite, 'freelist_count')).toBeGreaterThan(MinFreedPages);

        // 生产同款回收调用——NONE 模式下必须毫无效果（修复被回退就长这样）
        sqlite.pragma('incremental_vacuum');
        const after = footprint(sqlite);
        expect(after.pages).toBe(before.pages);
        expect(after.bytes).toBeGreaterThanOrEqual(before.bytes);
      } finally {
        sqlite.close();
      }
    });
  }, 60_000);

  it('initDb：把老库一次性转成 auto_vacuum=INCREMENTAL（文件头持久 + 数据完好）', async () => {
    await withIsolatedDb('vac-legacy-', async () => {
      const legacy = new Database(getDbPath());
      legacy.pragma('journal_mode = WAL');
      legacy.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
      const insert = legacy.prepare('INSERT INTO notes (body) VALUES (?)');
      const insertAll = legacy.transaction((rows: number) => {
        for (let i = 0; i < rows; i++) insert.run(BulkPayload);
      });
      insertAll(2000);
      expect(Number(legacy.pragma('auto_vacuum', { simple: true }))).toBe(0);
      legacy.close();

      const db = initDb();
      const sqlite = raw(db);
      // 仅 `PRAGMA auto_vacuum=INCREMENTAL` 不会改写文件头，必须跟随真实 VACUUM
      expect(pragmaNumber(sqlite, 'auto_vacuum')).toBe(2);
      // 转换重写页布局，不能破坏既有数据
      const notes = sqlite.prepare('SELECT COUNT(*) AS c FROM notes').get() as { c: number };
      expect(notes.c).toBe(2000);

      // 持久性：重开连接后仍是 INCREMENTAL（一次性成本，不每次启动重跑）
      await closeDb();
      resetDb();
      const probe = new Database(getDbPath());
      try {
        expect(Number(probe.pragma('auto_vacuum', { simple: true }))).toBe(2);
      } finally {
        probe.close();
      }
    });
  }, 60_000);

  it('会话级联删除：page_count 与文件字节同时下降（回收真的落到磁盘）', async () => {
    await withIsolatedDb('vac-delete-', async () => {
      const sqlite = raw(initDb());
      seedSession(sqlite, 'vac-session');
      seedBulkMessages(sqlite, 'vac-session');
      const before = footprint(sqlite);

      await service.delete('vac-session');

      const rows = sqlite
        .prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = 'vac-session'")
        .get() as { c: number };
      expect(rows.c).toBe(0);
      const after = footprint(sqlite);
      expect(before.pages - after.pages).toBeGreaterThanOrEqual(MinFreedPages);
      expect(after.bytes).toBeLessThan(before.bytes);
    });
  }, 60_000);

  it('上下文压缩（replaceMessages）：压缩掉的旧消息页被归还', async () => {
    await withIsolatedDb('vac-replace-', async () => {
      const sqlite = raw(initDb());
      seedSession(sqlite, 'vac-session');
      seedBulkMessages(sqlite, 'vac-session');
      const before = footprint(sqlite);

      const count = await service.replaceMessages('vac-session', [
        { role: 'user', content: '压缩后保留' },
      ]);
      expect(count).toBe(1);

      const after = footprint(sqlite);
      expect(before.pages - after.pages).toBeGreaterThanOrEqual(MinFreedPages);
      expect(after.bytes).toBeLessThan(before.bytes);
    });
  }, 60_000);

  it('统计窗口清理（pruneExpiredUsage）：删除行后回收空闲页', async () => {
    await withIsolatedDb('vac-prune-', async () => {
      const sqlite = raw(initDb());
      seedSession(sqlite, 'vac-session');
      seedBulkUsage(sqlite, 'vac-session');
      const before = footprint(sqlite);

      expect(service.pruneExpiredUsage()).toBe(BulkRows);

      const after = footprint(sqlite);
      expect(before.pages - after.pages).toBeGreaterThanOrEqual(MinFreedPages);
      expect(after.bytes).toBeLessThan(before.bytes);
    });
  }, 60_000);

  it('阈值守卫：freelist 未达阈值时返回 0，不动文件（小改动不反复截断）', async () => {
    await withIsolatedDb('vac-small-', () => {
      const sqlite = raw(initDb());
      seedSession(sqlite, 'small');
      const insert = sqlite.prepare(
        "INSERT INTO messages (session_id, seq, role, content, created_at) VALUES (?, ?, 'user', ?, 100)",
      );
      for (let i = 0; i < 5; i++) insert.run('small', i, BulkPayload);
      const before = footprint(sqlite);

      sqlite.exec("DELETE FROM messages WHERE session_id = 'small'");
      expect(pragmaNumber(sqlite, 'freelist_count')).toBeGreaterThan(0);
      expect(reclaimFreePages()).toBe(0);
      expect(footprint(sqlite).bytes).toBe(before.bytes);
    });
  }, 60_000);

  it('在途启动备份期间回收：不抛错，且备份副本仍是有效恢复点', async () => {
    await withIsolatedDb('vac-backup-', async (dir) => {
      // 先落成有 8MB 数据的库；closeDb 会 drain 掉这一轮备份
      const sqlite = raw(initDb());
      seedSession(sqlite, 'vac-session');
      seedBulkMessages(sqlite, 'vac-session');
      await closeDb();
      resetDb();

      const errorMock = vi.mocked(logger.error);
      errorMock.mockClear();

      // 重开：备份需拷完整 8MB，跨多个 tick；删除触发的 wal_checkpoint(TRUNCATE)
      // 必然发生在读事务仍持有期间——修复前无人验证过这一共存性
      initDb();
      await service.delete('vac-session');
      await closeDb();

      const backupDir = join(dir, 'backups');
      const names = readdirSync(backupDir);
      const backups = names.filter((n) => n.endsWith('.db'));
      expect(backups.length).toBeGreaterThanOrEqual(1);
      expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
      for (const name of backups) {
        const copy = Database(join(backupDir, name), { readonly: true });
        try {
          expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
        } finally {
          copy.close();
        }
      }
      expect(errorMock).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('数据库备份失败'),
      );
    });
  }, 60_000);

  it('reclaimFreePages：连接未初始化时抛错（不静默返回 0 掩盖问题）', async () => {
    await closeDb();
    resetDb();
    expect(() => reclaimFreePages()).toThrow(/未初始化/);
    // 恢复单例，避免污染 afterAll 的 closeDb
    initDb();
  });
});
