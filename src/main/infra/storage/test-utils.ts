import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { schema } from './schema';

export const TEST_MIGRATIONS_DIR = join(process.cwd(), 'drizzle');

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
