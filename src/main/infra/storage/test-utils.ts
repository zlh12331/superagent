// src/main/infra/storage/test-utils.ts
// 测试共享工具：用 drizzle-kit 迁移创建内存数据库
// ──────────────────────────────────────────────────────────────
// 目的：
// - schema.ts 为全库唯一真源，测试建库必须走同一套迁移（drizzle/ 目录），
//   避免测试再维护一份 SQL（schema-sql.ts 已退役）
// - 内存库每次 createTestDb 重新执行全部基线迁移（journal 表为空）
// ──────────────────────────────────────────────────────────────

import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { schema } from './schema';

/** drizzle 迁移目录（项目根 drizzle/，由 drizzle-kit generate 生成） */
export const TEST_MIGRATIONS_DIR = join(process.cwd(), 'drizzle');

/**
 * 创建内存数据库 + drizzle 实例（应用完整迁移，含 CHECK/UNIQUE/外键约束）
 */
export interface TestDb {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: Database.Database;
}

export function createTestDb(): TestDb {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: TEST_MIGRATIONS_DIR });
  return { db, sqlite };
}
