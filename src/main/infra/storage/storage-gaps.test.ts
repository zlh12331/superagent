// src/main/infra/storage/storage-gaps.test.ts
// storage 域 9 缺口补全：whitelist-pref 全路径（首次补测）、db 迁移/轮转/完整性分支
//
// 测试要点：
// 1. readWhitelistSync：有效条目通过 / 非法条目过滤 / 非数组 / 文件缺失 / JSON 损坏
// 2. writeWhitelist：整表覆写 + 日志
// 3. db：getDb 未初始化抛错 / closeDb 幂等 / 旧库 ALTER 迁移 + duplicate 跳过 / 备份轮转

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, initDb, resetDb } from './db';
import { readWhitelistSync, writeWhitelist } from './whitelist-pref';

const mocks = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockGetPath = vi.fn(() => '/tmp/storage-gaps');
  return { mockLogger, mockGetPath };
});

vi.mock('electron', () => ({
  app: { getPath: mocks.mockGetPath },
}));

vi.mock('../../utils/logger', () => ({
  logger: mocks.mockLogger,
}));

let tempDir: string;

describe('storage 域批次9 缺口补全', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = join(tmpdir(), `storage-gaps-${Date.now()}-${Math.floor(Math.random() * 10000)}`);
    mkdirSync(tempDir, { recursive: true });
    mocks.mockGetPath.mockReturnValue(tempDir);
    resetDb();
  });

  afterEach(() => {
    closeDb();
    resetDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('whitelist-pref（首次补测）', () => {
    it('读取：有效条目通过，非法条目过滤', () => {
      writeFileSync(
        join(tempDir, 'whitelist.json'),
        JSON.stringify({
          entries: [
            { toolName: 'run_command', pattern: 'npm test' },
            { toolName: 'run_command', pattern: 'pnpm build' },
            { toolName: 42, pattern: 'bad' },
            { toolName: 'missing-pattern' },
            null,
          ],
        }),
        'utf8',
      );

      const entries = readWhitelistSync();

      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({ toolName: 'run_command', pattern: 'npm test' });
    });

    it('读取：entries 非数组（对象结构）→ 回退空列表', () => {
      writeFileSync(join(tempDir, 'whitelist.json'), JSON.stringify({ entries: {} }), 'utf8');
      expect(readWhitelistSync()).toEqual([]);
    });

    it('读取：文件缺失 → 回退空列表', () => {
      expect(readWhitelistSync()).toEqual([]);
    });

    it('读取：JSON 损坏 → 回退空列表', () => {
      writeFileSync(join(tempDir, 'whitelist.json'), '{invalid json', 'utf8');
      expect(readWhitelistSync()).toEqual([]);
    });

    it('写入：整表覆写为 JSON 文件 + 日志', async () => {
      const entries = [
        { toolName: 'run_command', pattern: 'npm test' },
        { toolName: 'grep', pattern: 'foo' },
      ];

      await writeWhitelist(entries);

      const raw = readFileSync(join(tempDir, 'whitelist.json'), 'utf8');
      expect(JSON.parse(raw)).toEqual({ entries });
      expect(mocks.mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ count: 2 }),
        '命令白名单已保存',
      );
    });
  });

  describe('db 补充', () => {
    it('getDb 未初始化：抛错提示先调用 initDb', () => {
      expect(() => getDb()).toThrow('数据库未初始化');
    });

    it('getDb 已初始化：返回同一 drizzle 实例', () => {
      const db = initDb();
      expect(getDb()).toBe(db);
    });

    it('closeDb：关闭后 getDb 抛错；再次 closeDb 幂等', () => {
      const db = initDb();
      expect(db).toBeDefined();
      closeDb();
      expect(() => getDb()).toThrow('数据库未初始化');
      // 幂等：二次调用不抛
      expect(() => closeDb()).not.toThrow();
    });

    it('完整性校验通过：记录日志（新库 integrity=ok）', () => {
      initDb();
      expect(mocks.mockLogger.info).toHaveBeenCalledWith({}, 'SQLite 完整性校验通过');
    });

    it('旧库迁移：无新列时 ALTER 添加，重复 initDb 触发 duplicate 跳过', () => {
      // 预建旧库（只有 sessions 基础列，无 working_dir/pinned/last_run_status）
      const dbPath = join(tempDir, 'sessions.db');
      const Database = require('better-sqlite3') as new (
        p: string,
      ) => {
        exec(sql: string): void;
        close(): void;
      };
      const old = new Database(dbPath);
      old.exec(
        `CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT 0
        );`,
      );
      old.close();

      // 首次 initDb：三个 ALTER 成功（无 duplicate）
      initDb();
      // 重复 initDb（单例缓存）不重新迁移——resetDb 后模拟重启，此时列已存在 → duplicate 跳过
      closeDb();
      resetDb();
      initDb();
      // duplicate 跳过日志（至少 working_dir 分支触发）
      expect(mocks.mockLogger.info).toHaveBeenCalledWith(
        {},
        'sessions.working_dir 列已存在，跳过 ALTER',
      );
    });

    it('备份轮转：保留最近 3 份，删除过期备份', async () => {
      // 预置 5 个备份文件（initDb 的异步备份会追加 1 份）
      const backupDir = join(tempDir, 'backups');
      mkdirSync(backupDir, { recursive: true });
      for (let i = 1; i <= 5; i += 1) {
        writeFileSync(join(backupDir, `sessions-2026-08-0${i}T00-00-00.db`), 'x', 'utf8');
      }

      initDb();
      // 等待异步热备份 + 轮转完成
      await new Promise((resolve) => setTimeout(resolve, 500));

      const { readdirSync } = require('node:fs') as typeof import('node:fs');
      const remaining = readdirSync(backupDir).filter((n) => n.endsWith('.db'));
      // 初始 5 份 + 本次备份 1 份 = 6 份，轮转保留 3 份
      expect(remaining.length).toBe(3);
      expect(mocks.mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ stale: expect.any(String) }),
        '轮转删除过期备份',
      );
    });

    it('备份失败（backups 路径被文件占用）：记录错误不阻断启动', async () => {
      // 把 backups 位置占为文件 → mkdirSync 抛 → backupDatabase catch
      writeFileSync(join(tempDir, 'backups'), 'not a dir', 'utf8');

      const db = initDb();
      expect(db).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(mocks.mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(String) }),
        '数据库备份失败',
      );
    });
  });
});
