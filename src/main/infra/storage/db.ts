// src/main/infra/storage/db.ts
// SQLite + Drizzle ORM 初始化
// ──────────────────────────────────────────────────────────────
// 职责：
// - 初始化 better-sqlite3 数据库连接（同步驱动，适合 Electron 主进程）
// - 创建 drizzle-orm 实例并暴露 db 对象
// - 自动建表（IF NOT EXISTS）+ 创建索引
// - 应用退出时关闭连接（通过 dispose 函数）
//
// 设计：
// - 数据库文件位置：%APPDATA%/<AppName>/sessions.db（与 keychain.dat 同目录）
// - WAL 模式：提升并发读性能（better-sqlite3 默认开启）
// - 单例模式：与 FileService / GitService 一致，便于统一生命周期管理
// - Drizzle 的 better-sqlite3 driver 是同步的，无需 await
// ──────────────────────────────────────────────────────────────

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { app } from 'electron';
import { logger } from '../../utils/logger';
import { schema } from './schema';

/**
 * 数据库文件名
 *
 * 存放在 userData 目录下，与 keychain.dat / logs/ 同级。
 */
const DB_FILENAME = 'sessions.db';

/**
 * 获取数据库文件路径
 *
 * 路径：%APPDATA%/<AppName>/sessions.db
 * - dev 环境：%PROJECT%/.electron-user-data/sessions.db
 * - prod 环境：%APPDATA%/novel-writer-agent/sessions.db
 *
 * 外部导出供测试使用（注入临时路径）。
 */
export function getDbPath(): string {
  const userDataPath = app.getPath('userData');
  return join(userDataPath, DB_FILENAME);
}

/** drizzle 实例类型（基于 schema 推导） */
type DrizzleDB = BetterSQLite3Database<typeof schema>;

/** 数据库实例缓存（单例，首次调用 initDb 创建） */
let dbInstance: DrizzleDB | null = null;
/** better-sqlite3 原始实例缓存（用于关闭连接） */
let sqliteInstance: Database.Database | null = null;

/**
 * 初始化数据库
 *
 * 流程：
 * 1. 确保 userData 目录存在（mkdirSync recursive）
 * 2. 打开 better-sqlite3 连接（同步）
 * 3. 配置 WAL 模式（提升并发读性能）
 * 4. 创建 drizzle 实例
 * 5. 建表（CREATE TABLE IF NOT EXISTS，幂等）
 * 6. 创建索引（CREATE INDEX IF NOT EXISTS，幂等）
 *
 * @returns drizzle 实例（后续 SessionService 使用）
 */
export function initDb(): DrizzleDB {
  if (dbInstance !== null) {
    return dbInstance;
  }

  const dbPath = getDbPath();
  // 确保父目录存在（dev 环境 userData 目录可能不存在）
  const dir = join(dbPath, '..');
  mkdirSync(dir, { recursive: true });

  logger.info({ dbPath }, '初始化 SQLite 数据库');

  // 打开 SQLite 连接（同步）
  // better-sqlite3 是同步驱动，所有操作都是阻塞的，适合 Electron 主进程
  const sqlite = new Database(dbPath);
  // 启用 WAL 模式（Write-Ahead Logging）：提升并发读性能
  // 写入仍为串行，但读不阻塞写
  sqlite.pragma('journal_mode = WAL');
  // 启用外键约束（SQLite 默认关闭，drizzle schema 中 references 依赖此）
  sqlite.pragma('foreign_keys = ON');

  // 创建 drizzle 实例
  const db = drizzle(sqlite, { schema });

  // 建表（幂等，已存在则跳过）
  // 使用原始 SQL 而非 drizzle migrate，避免引入迁移文件管理复杂度
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_message TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      working_dir TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_prompts_role ON prompts(role);
  `);

  // 迁移：已存在的数据库加 working_dir 列（幂等）
  // 新库建表时已包含此列，ALTER 仅对老库生效
  // "duplicate column name" 错误表示列已存在，忽略即可
  try {
    sqlite.exec(`ALTER TABLE sessions ADD COLUMN working_dir TEXT NOT NULL DEFAULT '';`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('duplicate column name')) {
      logger.info({}, 'sessions.working_dir 列已存在，跳过 ALTER');
    } else {
      throw err;
    }
  }

  dbInstance = db;
  sqliteInstance = sqlite;
  logger.info({ dbPath }, 'SQLite 数据库初始化完成');
  return db;
}

/**
 * 获取 drizzle 实例
 *
 * 必须在 initDb 之后调用，否则抛错。
 * SessionService 通过此函数获取 db 实例。
 *
 * @throws Error 如果未初始化
 */
export function getDb(): DrizzleDB {
  if (dbInstance === null) {
    throw new Error('数据库未初始化，请先调用 initDb()');
  }
  return dbInstance;
}

/**
 * 关闭数据库连接
 *
 * 应用退出时调用，释放 SQLite 文件句柄。
 * WAL 模式下关闭会自动 checkpoint（合并 WAL 到主数据库）。
 *
 * 幂等：多次调用安全。
 */
export function closeDb(): void {
  if (sqliteInstance !== null) {
    sqliteInstance.close();
    sqliteInstance = null;
    dbInstance = null;
    logger.info({}, 'SQLite 数据库连接已关闭');
  }
}

/**
 * 重置数据库实例（仅测试用）
 *
 * 测试场景：每个测试用例独立数据库，需要重置单例缓存。
 * 不调用 closeDb（不关闭真实连接），仅清空缓存引用。
 */
export function resetDb(): void {
  dbInstance = null;
  sqliteInstance = null;
}
