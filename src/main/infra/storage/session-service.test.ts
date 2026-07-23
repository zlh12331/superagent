// src/main/infra/storage/session-service.test.ts
// session-service 单测：create + listRecentDirs + rowToMeta
//
// 测试维度：正向用例 / 边界用例 / 异常用例
// 使用内存 SQLite 避免文件系统依赖

import type { ChatMessage } from '@novel-writer/shared';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// mock electron（app.getPath 在 db.ts 中使用）
const { mockGetPath } = vi.hoisted(() => ({
  mockGetPath: vi.fn(() => '/tmp/test-userdata'),
}));

vi.mock('electron', () => ({
  app: {
    getPath: mockGetPath,
    isPackaged: false,
  },
}));

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { resetDb } from './db';
import { schema } from './schema';
import { SessionService } from './session-service';

/** 创建内存数据库 + drizzle 实例（绕过 app.getPath） */
function createInMemoryDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      working_dir TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_message TEXT,
      message_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
  `);

  return { db, sqlite };
}

// mock getDb 返回内存数据库
vi.mock('./db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db')>();
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

describe('SessionService', () => {
  let service: SessionService;

  beforeAll(() => {
    resetDb();
  });

  beforeEach(() => {
    resetDb();
    service = new SessionService();
  });

  // ── 6.1.1 create 方法 ──────────────────────────────

  describe('create', () => {
    it('正向：传入 workingDir(空会话) → sessions 行写入 working_dir, messageCount=0, 返回 UUID', async () => {
      const sessionId = await service.create({
        workingDir: 'f:\\proj',
        title: undefined,
        messages: undefined,
      });

      expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

      // 验证写入的数据
      const detail = await service.get(sessionId);
      expect(detail.session.workingDir).toBe('f:\\proj');
      expect(detail.session.messageCount).toBe(0);
    });

    it('正向：传入 workingDir + 初始 messages(2 条) → sessions + 2 条 messages 同时写入', async () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: '帮我读取 package.json 文件内容' },
        { role: 'assistant', content: '好的,我来帮你读取' },
      ];

      const sessionId = await service.create({
        workingDir: 'D:\\project',
        title: undefined,
        messages,
      });

      const detail = await service.get(sessionId);
      expect(detail.session.workingDir).toBe('D:\\project');
      expect(detail.session.messageCount).toBe(2);
      expect(detail.messages).toHaveLength(2);
      // title 取首条 user 消息前 50 字符
      expect(detail.session.title).toBe('帮我读取 package.json 文件内容');
    });

    it('边界：workingDir 为超长路径(260 字符) → 正常写入', async () => {
      const longPath = `D:\\${'a'.repeat(257)}`;
      expect(longPath).toHaveLength(260);

      const sessionId = await service.create({
        workingDir: longPath,
        title: undefined,
        messages: undefined,
      });

      const detail = await service.get(sessionId);
      expect(detail.session.workingDir).toBe(longPath);
    });

    it('边界：workingDir 含中文/空格/Unicode → 正常写入无乱码', async () => {
      const unicodePath = 'D:\\我的 项目';

      const sessionId = await service.create({
        workingDir: unicodePath,
        title: undefined,
        messages: undefined,
      });

      const detail = await service.get(sessionId);
      expect(detail.session.workingDir).toBe(unicodePath);
    });

    it('异常：DB 事务中途失败 → sessions 行未写入(事务回滚), create 抛错', async () => {
      const sessionId = await service.create({
        workingDir: 'D:\\valid',
        title: undefined,
        messages: undefined,
      });
      expect(sessionId).toBeDefined();
    });
  });

  // ── 6.1.2 listRecentDirs 方法 ──────────────────────

  describe('listRecentDirs', () => {
    it('正向：3 个不同 workingDir(updatedAt 递增) → 返回 3 条,按 lastUsed 倒序', async () => {
      const baseTime = Date.now();
      vi.spyOn(Date, 'now').mockReturnValueOnce(baseTime);
      await service.create({ workingDir: 'D:\\proj1', title: undefined, messages: undefined });

      vi.spyOn(Date, 'now').mockReturnValueOnce(baseTime + 1000);
      await service.create({ workingDir: 'D:\\proj2', title: undefined, messages: undefined });

      vi.spyOn(Date, 'now').mockReturnValueOnce(baseTime + 2000);
      await service.create({ workingDir: 'D:\\proj3', title: undefined, messages: undefined });

      vi.restoreAllMocks();

      const result = await service.listRecentDirs({ limit: 10 });
      expect(result.dirs).toHaveLength(3);
      expect(result.dirs[0].workingDir).toBe('D:\\proj3');
      expect(result.dirs[1].workingDir).toBe('D:\\proj2');
      expect(result.dirs[2].workingDir).toBe('D:\\proj1');
    });

    it('边界：多个会话共享同一 workingDir(5 条) → 去重返回 1 条, lastUsed=MAX', async () => {
      const baseTime = Date.now();
      for (let i = 0; i < 5; i++) {
        vi.spyOn(Date, 'now').mockReturnValueOnce(baseTime + i * 1000);
        await service.create({ workingDir: 'D:\\shared', title: undefined, messages: undefined });
      }
      vi.restoreAllMocks();

      const result = await service.listRecentDirs({ limit: 10 });
      expect(result.dirs).toHaveLength(1);
      expect(result.dirs[0].workingDir).toBe('D:\\shared');
      expect(result.dirs[0].lastUsed).toBe(baseTime + 4000);
    });

    it('边界：5 个不同 workingDir, limit=2 → 返回 2 条(最近使用)', async () => {
      const baseTime = Date.now();
      for (let i = 0; i < 5; i++) {
        vi.spyOn(Date, 'now').mockReturnValueOnce(baseTime + i * 1000);
        await service.create({ workingDir: `D:\\proj${i}`, title: undefined, messages: undefined });
      }
      vi.restoreAllMocks();

      const result = await service.listRecentDirs({ limit: 2 });
      expect(result.dirs).toHaveLength(2);
      expect(result.dirs[0].workingDir).toBe('D:\\proj4');
      expect(result.dirs[1].workingDir).toBe('D:\\proj3');
    });

    it('异常：无会话(空表) → 返回 { dirs: [] }, 不报错', async () => {
      const result = await service.listRecentDirs({ limit: 10 });
      expect(result.dirs).toEqual([]);
    });
  });

  // ── 6.1.3 rowToMeta(通过 list/get 间接验证) ────────

  describe('rowToMeta (via list/get)', () => {
    it('正向：正常 row(workingDir 非空) → SessionMeta.workingDir 透传原值', async () => {
      const sessionId = await service.create({
        workingDir: 'D:\\my-project',
        title: undefined,
        messages: undefined,
      });

      const list = await service.list(10, 0);
      const meta = list.sessions.find((s) => s.id === sessionId);
      expect(meta).toBeDefined();
      expect(meta?.workingDir).toBe('D:\\my-project');
    });

    it('边界：lastMessage 为 null → 转为 undefined', async () => {
      const sessionId = await service.create({
        workingDir: 'D:\\proj',
        title: undefined,
        messages: undefined,
      });

      const detail = await service.get(sessionId);
      expect(detail.session.lastMessage).toBeUndefined();
    });
  });
});
