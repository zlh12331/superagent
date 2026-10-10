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

/**
 * 创建内存测试数据库：`:memory:` SQLite + drizzle，应用完整迁移
 * （含 CHECK/UNIQUE/外键约束，WAL + foreign_keys=ON）
 */
export function createTestDb(): TestDb {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: TEST_MIGRATIONS_DIR });
  return { db, sqlite };
}
