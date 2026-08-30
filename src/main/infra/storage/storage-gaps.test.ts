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
  app: {
    getPath: mocks.mockGetPath,
    // initDb 的 resolveMigrationsDir 需要：dev 环境指向项目根 drizzle/
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
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

  afterEach(async () => {
    await closeDb();
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

    it('closeDb：关闭后 getDb 抛错；再次 closeDb 幂等', async () => {
      const db = initDb();
      expect(db).toBeDefined();
      await closeDb();
      expect(() => getDb()).toThrow('数据库未初始化');
      // 幂等：二次调用不抛
      await expect(closeDb()).resolves.toBeUndefined();
    });

    it('完整性校验通过：记录日志（新库 integrity=ok）', () => {
      initDb();
      expect(mocks.mockLogger.info).toHaveBeenCalledWith({}, 'SQLite 完整性校验通过');
    });

    it('drizzle 迁移：全新库建全表 + journal 幂等 + 约束生效，重复 initDb 不抛', async () => {
      initDb();
      const dbPath = join(tempDir, 'sessions.db');
      const Database = require('better-sqlite3') as new (
        p: string,
      ) => {
        exec(sql: string): void;
        prepare(sql: string): {
          all(): readonly { name: string }[];
          run(...args: unknown[]): unknown;
        };
        pragma(p: string, opts?: { simple?: boolean }): unknown;
        close(): void;
      };
      const check = new Database(dbPath);
      // 全部 11 张表 + drizzle journal 表
      const tables = check
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name);
      expect(tables).toEqual(
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
          '__drizzle_migrations',
        ]),
      );
      // 约束生效：非法 role 插入被 CHECK 拒绝
      expect(() =>
        check
          .prepare(
            "INSERT INTO messages (session_id, seq, role, content, created_at) VALUES ('s','0','bogus','x',0)",
          )
          .run(),
      ).toThrow(/CHECK/);
      check.close();

      // 重复 initDb（resetDb 后模拟重启）：journal 已记录，迁移不再执行，幂等不抛
      await closeDb();
      resetDb();
      expect(() => initDb()).not.toThrow();
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
