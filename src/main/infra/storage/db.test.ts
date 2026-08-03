// src/main/infra/storage/db.test.ts
// db 单测：SQLite 初始化（真实 better-sqlite3 + 临时目录，drizzle sql API）

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
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
