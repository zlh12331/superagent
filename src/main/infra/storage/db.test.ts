import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { restrictFileAccessWin32Mock } = vi.hoisted(() => ({
  restrictFileAccessWin32Mock: vi.fn(),
}));
vi.mock('./keychain', () => ({ restrictFileAccessWin32: restrictFileAccessWin32Mock }));

import { logger } from '../../utils/logger';
import {
  closeDb,
  drainPendingBackups,
  getDb,
  getDbPath,
  initDb,
  reclaimFreePages,
  resetDb,
} from './db';
import { SessionService } from './session-service';

let tempDir: string;

describe('db', () => {
  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'code-agent-db-test-'));
    mockApp.getPath.mockReturnValue(tempDir);
  });

  afterAll(async () => {
    await closeDb();
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  });

  beforeEach(() => {
    resetDb();
  });

  it('getDbPath：指向 userData 下的 sessions.db', () => {
    expect(getDbPath()).toBe(join(tempDir, 'sessions.db'));
  });

  it('win32：打开后对 db/-wal/-shm 调用 ACL 收紧（2026-09-28 深读收口）', () => {
    resetDb();
    restrictFileAccessWin32Mock.mockClear();
    initDb();
    if (process.platform !== 'win32') {
      expect(restrictFileAccessWin32Mock).not.toHaveBeenCalled();
      return;
    }
    const dbPath = getDbPath();
    const called = restrictFileAccessWin32Mock.mock.calls.map((c) => c[0]);
    expect(called).toContain(dbPath);
    expect(called).toContain(`${dbPath}-wal`);
    expect(called).toContain(`${dbPath}-shm`);
  });

  it('initDb 热备份：原子落位 sessions-*.db、无 .tmp 残留、备份可校验', async () => {
    resetDb();
    initDb();
    const backupDir = join(tempDir, 'backups');

    await drainPendingBackups();

    const names = readdirSync(backupDir);
    const backups = names.filter((n) => n.endsWith('.db'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);

    const backupFile = backups.sort().at(-1);
    if (backupFile === undefined) throw new Error('备份文件未生成');
    const backup = Database(join(backupDir, backupFile), { readonly: true });
    try {
      expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
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
      await drainPendingBackups();

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

  it('initDb：文件头损坏（非 SQLite 文件）也能自愈重建，不抛错（2026-09-08 P0 修复）', async () => {
    const isolatedDir = mkdtempSync(join(tempDir, 'corrupt-header-'));
    mockApp.getPath.mockReturnValue(isolatedDir);
    const dbPath = join(isolatedDir, 'sessions.db');

    try {
      writeFileSync(dbPath, 'this is definitely not a sqlite database file at all');

      resetDb();
      expect(() => initDb()).not.toThrow();

      const archived = readdirSync(isolatedDir).filter((n) => n.includes('.corrupt-'));
      expect(archived.length).toBeGreaterThan(0);

      const db = getDb();
      expect(db).toBeDefined();
      await closeDb();
    } finally {
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
      await closeDb();

      const names = readdirSync(backupDir);
      const backups = names.filter((n) => n.endsWith('.db'));
      const [backupFile] = backups;
      expect(backups).toHaveLength(1);
      expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
      if (backupFile === undefined) throw new Error('备份文件未生成');
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

describe('领域约束生效', () => {
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
    expect(() =>
      raw(db)
        .prepare(
          "INSERT INTO messages (session_id, seq, role, content, created_at) VALUES ('s4', 0, 'user', 'y', 100)",
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/i);
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

describe('老库升级（增量迁移）', () => {
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

  it('旧 schema 库 → 数据保真 + 约束补齐 + journal 十条，重复 initDb 幂等', async () => {
    resetDb();
    await closeDb();
    const legacyDir = mkdtempSync(join(tmpdir(), 'code-agent-db-legacy-v2-'));
    mockApp.getPath.mockReturnValue(legacyDir);
    try {
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

      const db = initDb();

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

      expect(() =>
        raw(db)
          .prepare(
            "INSERT INTO messages (session_id, seq, role, content, created_at) VALUES ('legacy-session', 1, 'bogus', 'x', 0)",
          )
          .run(),
      ).toThrow(/CHECK constraint failed/i);

      expect(() =>
        raw(db)
          .prepare(
            "INSERT INTO turns (turn_id, session_id, seq, model_id, status, created_at) VALUES ('legacy-turn', 'legacy-session', 1, 'm', 'completed', 100)",
          )
          .run(),
      ).toThrow(/UNIQUE constraint failed/i);

      const migs = raw(db).prepare('SELECT hash FROM __drizzle_migrations').all();
      expect(migs).toHaveLength(10);

      await closeDb();
      resetDb();
      expect(() => initDb()).not.toThrow();
    } finally {
      await closeDb();
      mockApp.getPath.mockReturnValue(tempDir);
      try {
        rmSync(legacyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {}
    }
  }, 30_000);

  it('新库：0000 ~ 0009 全执行（journal 十条），约束齐全', async () => {
    resetDb();
    await closeDb();
    const freshDir = mkdtempSync(join(tmpdir(), 'code-agent-db-fresh-v2-'));
    mockApp.getPath.mockReturnValue(freshDir);
    try {
      const db = initDb();
      const migs = raw(db).prepare('SELECT hash FROM __drizzle_migrations').all();
      expect(migs).toHaveLength(10);
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
      } catch {}
    }
  });
});

describe('空间回收（SQLite 磁盘占用）', () => {
  const BulkRows = 4000;
  const BulkPayload = 'x'.repeat(2000);
  const MinFreedPages = 1000;

  const service = new SessionService();

  function raw(db: ReturnType<typeof initDb>): Database.Database {
    return (db as unknown as { $client: Database.Database }).$client;
  }

  function pragmaNumber(sqlite: Database.Database, statement: string): number {
    return Number(sqlite.pragma(statement, { simple: true }));
  }

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
      } catch {}
    }
  }

  it('对照组：未转换的库（auto_vacuum=NONE）删除后 incremental_vacuum 归还不了任何页', async () => {
    await withIsolatedDb('vac-none-', () => {
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
        expect(pragmaNumber(sqlite, 'auto_vacuum')).toBe(0);
        expect(pragmaNumber(sqlite, 'freelist_count')).toBeGreaterThan(MinFreedPages);

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
      expect(pragmaNumber(sqlite, 'auto_vacuum')).toBe(2);
      const notes = sqlite.prepare('SELECT COUNT(*) AS c FROM notes').get() as { c: number };
      expect(notes.c).toBe(2000);

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
      const sqlite = raw(initDb());
      seedSession(sqlite, 'vac-session');
      seedBulkMessages(sqlite, 'vac-session');
      await closeDb();
      resetDb();

      const errorMock = vi.mocked(logger.error);
      errorMock.mockClear();

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
    initDb();
  });
});
