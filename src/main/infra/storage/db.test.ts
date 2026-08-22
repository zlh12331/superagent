// src/main/infra/storage/db.test.ts
// db 单测：SQLite 初始化（真实 better-sqlite3 + 临时目录，drizzle sql API）

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockApp } = vi.hoisted(() => ({
  mockApp: { getPath: vi.fn(() => '/tmp/db-test') },
}));

vi.mock('electron', () => ({ app: mockApp }));

import { closeDb, getDbPath, initDb, resetDb } from './db';

let tempDir: string;

describe('db', () => {
  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'code-agent-db-test-'));
    mockApp.getPath.mockReturnValue(tempDir);
  });

  afterAll(() => {
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

  it('initDb：创建数据库并建表（sessions/messages/prompts）', () => {
    const db = initDb();
    const rows = db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type='table'`);
    const names = rows.map((r) => r.name);
    expect(names).toContain('sessions');
    expect(names).toContain('messages');
    expect(names).toContain('prompts');
  });

  it('initDb：幂等（重复调用返回同一实例）', () => {
    expect(initDb()).toBe(initDb());
  });

  it('initDb：索引已创建', () => {
    resetDb();
    const db = initDb();
    const rows = db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type='index'`);
    const names = rows.map((r) => r.name);
    expect(names).toContain('idx_sessions_updated_at');
    expect(names).toContain('idx_messages_session_seq');
    expect(names).toContain('idx_prompts_role');
  });

  it('数据库文件已创建在临时目录', () => {
    initDb();
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    expect(existsSync(join(tempDir, 'sessions.db'))).toBe(true);
  });
});

// ── schema 一致性（防 drift：Drizzle 表名字符串 vs 原始 SQL 单一真源）──
describe('schema 一致性', () => {
  it('schema.ts 与 schema-sql.ts 表级一致', async () => {
    const { schema } = await import('./schema');
    const { SCHEMA_SQL } = await import('./schema-sql');
    const sqlTables = new Set(
      [...SCHEMA_SQL.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"?([a-z_]+)"?/gi)].map(
        (m) => m[1]?.toLowerCase() ?? '',
      ),
    );
    // sqliteTable('<表名>', ...) 的字符串参数为表名真源（导出变量名 camelCase 是惯例）
    // 表名经 drizzle:Name symbol 存于表对象（TS 下 symbol 索引需显式 cast）
    const drizzleTables = new Set(
      Object.values(schema).map((t) => {
        const tbl = t as unknown as Record<symbol, unknown>;
        const name = tbl[Symbol.for('drizzle:Name')];
        const table = tbl[Symbol.for('drizzle:Table')] as { name?: string } | undefined;
        return typeof name === 'string' ? name : (table?.name ?? '');
      }),
    );
    for (const t of drizzleTables) {
      if (t === '') continue;
      expect(sqlTables, `Drizzle 表 ${t} 应在 SCHEMA_SQL 中定义`).toContain(t);
    }
  });

  it('schema.ts 与实际建库列级一致（防「只改 Drizzle 忘改 SQL」的漂移）', async () => {
    const db = initDb();
    const { schema } = await import('./schema');
    const { getTableColumns } = await import('drizzle-orm');
    for (const t of Object.values(schema)) {
      const tbl = t as unknown as Record<symbol, unknown>;
      const name = tbl[Symbol.for('drizzle:Name')];
      const tableName = typeof name === 'string' ? name : '';
      if (tableName === '') continue;
      const cols = getTableColumns(t as SQLiteTable);
      const drizzleCols = new Set(Object.values(cols).map((c) => (c as { name: string }).name));
      const rows = db.all<{ name: string }>(sql`PRAGMA table_info(${sql.raw(tableName)})`);
      const sqliteCols = new Set(rows.map((r) => r.name));
      expect(sqliteCols.size, `表 ${tableName} 在库中不存在`).toBeGreaterThan(0);
      for (const c of drizzleCols) {
        expect(
          sqliteCols.has(c),
          `表 ${tableName} 缺少列 ${c}（SCHEMA_SQL/schema-sql.ts 未同步）`,
        ).toBe(true);
      }
    }
  });
});

// ── 老库升级（迁移链完整性：P1 回归——turn_id 曾无迁移条目导致启动崩溃）──
describe('老库升级', () => {
  it('缺 turn_id 的 v5 老库升级成功、数据保留、索引补齐', async () => {
    resetDb();
    closeDb();
    const { default: Database } = await import('better-sqlite3');
    // 独立子目录构造老库：避免与共享临时目录中既有库文件产生 Windows 句柄竞争
    const legacyDir = mkdtempSync(join(tmpdir(), 'code-agent-db-legacy-'));
    mockApp.getPath.mockReturnValue(legacyDir);
    try {
      const dbPath = getDbPath();
      // 手工构造 v5 形态老库：messages 无 turn_id，user_version=5
      const legacy = new Database(dbPath);
      legacy.exec(`
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
          seq INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT INTO sessions (id, title, created_at, updated_at, message_count)
          VALUES ('legacy-session', 'Legacy Session', 1700000000000, 1700000000000, 1);
        INSERT INTO messages (session_id, seq, role, content, created_at)
          VALUES ('legacy-session', 0, 'user', '历史消息', 1700000000000);
        PRAGMA user_version = 5;
      `);
      legacy.close();

      // 修复前：此处抛「no such column: turn_id」（SCHEMA_SQL 的索引先于迁移执行）
      const db = initDb();

      const msgCols = db.all<{ name: string }>(sql`PRAGMA table_info(messages)`).map((r) => r.name);
      expect(msgCols).toContain('turn_id');
      const indexes = db
        .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type='index'`)
        .map((r) => r.name);
      expect(indexes).toContain('idx_messages_turn');
      // 迁移不得破坏既有数据
      const msgs = db.all<{ content: string }>(sql`SELECT content FROM messages`);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.content).toBe('历史消息');
      // 版本落位当前（PRAGMA 结果列名为 user_version）
      const versionRow = db.get<Record<string, number>>(sql`PRAGMA user_version`);
      const { CURRENT_SCHEMA_VERSION } = await import('./migrations');
      expect(versionRow?.['user_version'] ?? -1).toBe(CURRENT_SCHEMA_VERSION);

      // 本用例位于文件末尾：等待 initDb 触发的异步热备份落定，
      // 避免其日志在 vitest worker 关闭后到达触发 EnvironmentTeardownError
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      closeDb();
      mockApp.getPath.mockReturnValue(tempDir);
      // Windows 句柄延迟释放：清理失败不阻塞测试结果（临时目录由系统回收）
      try {
        rmSync(legacyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // 句柄未释放时跳过清理
      }
    }
  });
});
