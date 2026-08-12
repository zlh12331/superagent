// tests/integration/helpers/temp-db.ts
// 集成测试共享基建：临时文件 SQLite 工厂（简化环境 Medium Test 的数据隔离标准做法）
// ──────────────────────────────────────────────────────────────
// 每用例独立临时文件 DB：测试间零状态残留、可并行；用后必清理。
// 对应用例：await withTempDb(async (db) => { ... })
// ──────────────────────────────────────────────────────────────

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../../src/main/infra/storage/schema-sql';

/** 临时 DB 上下文：db 实例 + 文件路径（清理时用） */
export interface TempDb {
  /** 已迁移到最新 schema 的数据库实例 */
  readonly db: Database.Database;
  /** 临时文件路径（每用例唯一，用后由 withTempDb 清理） */
  readonly path: string;
}

/**
 * 创建并迁移一个独立临时文件 DB，执行回调后清理。
 *
 * @param fn 用例逻辑（收到 TempDb 上下文）
 */
export async function withTempDb<T>(fn: (ctx: TempDb) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'code-agent-it-'));
  const path = join(dir, 'test.db');
  const db = new Database(path);
  try {
    // SCHEMA_SQL 为生产/测试共用真源（幂等建表），与 initDb 迁移路径一致
    db.exec(SCHEMA_SQL);
    return await fn({ db, path });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, maxRetries: 5 });
  }
}
