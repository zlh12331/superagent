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

import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { app } from 'electron';
import { logger } from '../../utils/logger';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from './migrations';
import { schema } from './schema';
import { SCHEMA_SQL } from './schema-sql';

/**
 * 数据库文件名
 *
 * 存放在 userData 目录下，与 keychain.dat / logs/ 同级。
 */
const DB_FILENAME = 'sessions.db';
/** 备份保留份数（自动轮转，保留最近 N 份） */
const BACKUP_KEEP = 3;
/** 备份目录名（位于 userData 下） */
const BACKUP_DIR = 'backups';

/**
 * 限制敏感数据文件权限为仅属主可读写（0o600）
 *
 * 安全修复：SQLite 含完整对话历史（工具参数/文件内容/命令输出），
 * 默认 umask（Linux 常为 644）下同机其他进程可读。Windows 依赖 OS ACL，跳过。
 */
function restrictFilePermissions(filePath: string): void {
  if (process.platform === 'win32') {
    return;
  }
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // 权限设置失败不阻断（只读文件系统等场景）
  }
}

/**
 * 启动时热备份数据库（better-sqlite3 内置 backup API，不中断服务）
 *
 * 轮转策略：写入 backups/sessions-<时间戳>.db，删除超出 BACKUP_KEEP 的最旧备份。
 * 崩溃后可从备份恢复（配合 WAL 崩溃恢复双保险）。
 * 注意：better-sqlite3 的 backup() 是异步 API，必须 await，否则拒绝未被捕获。
 */
async function backupDatabase(sqlite: Database.Database, dbPath: string): Promise<void> {
  try {
    const backupDir = join(dirname(dbPath), BACKUP_DIR);
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = join(backupDir, `sessions-${stamp}.db`);
    // 安全修复：先以 0600 预创建空文件再交给 sqlite.backup 截断写入——
    // 此前备份以默认 umask（644）完整落盘后才 chmod，POSIX 下存在
    // 其他进程读到明文对话历史的窗口期。openSync 'a' 不截断已存在文件。
    if (process.platform !== 'win32') {
      try {
        closeSync(openSync(backupPath, 'a', 0o600));
      } catch {
        // 预创建失败不阻断（backup 会按原逻辑创建，restrictFilePermissions 兜底）
      }
    }
    await sqlite.backup(backupPath);
    // 安全修复：备份含完整对话历史，同样限制为仅属主可读写
    restrictFilePermissions(backupPath);
    logger.info({ backupPath }, '数据库热备份完成');

    // 轮转：删除超出保留份数的最旧备份
    const backups = readdirSync(backupDir)
      .filter((name) => name.startsWith('sessions-') && name.endsWith('.db'))
      .sort();
    const excess = backups.length - BACKUP_KEEP;
    for (let i = 0; i < excess; i++) {
      const stale = join(backupDir, backups[i] ?? '');
      unlinkSync(stale);
      logger.info({ stale }, '轮转删除过期备份');
    }
  } catch (error) {
    // 备份失败不阻断启动（日志中可诊断）
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      '数据库备份失败',
    );
  }
}

/**
 * 获取数据库文件路径
 *
 * 路径：%APPDATA%/<AppName>/sessions.db
 * - dev 环境：%PROJECT%/.electron-user-data/sessions.db
 * - prod 环境：%APPDATA%/code-agent-agent/sessions.db
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
  // 安全修复：限制数据库文件权限为仅属主可读写（含后续 WAL/SHM 伴随文件）
  restrictFilePermissions(dbPath);
  // 启用 WAL 模式（Write-Ahead Logging）：提升并发读性能
  // 写入仍为串行，但读不阻塞写；崩溃后由 WAL 自动恢复
  sqlite.pragma('journal_mode = WAL');
  restrictFilePermissions(`${dbPath}-wal`);
  restrictFilePermissions(`${dbPath}-shm`);
  // 启用外键约束（SQLite 默认关闭，drizzle schema 中 references 依赖此）
  sqlite.pragma('foreign_keys = ON');

  // P2：外部工具（drizzle-kit studio / sqlite CLI）占用库文件时短暂等待，
  // 而非立刻抛 SQLITE_BUSY 表现为随机 IPC INTERNAL_ERROR（单实例锁不约束外部进程）
  sqlite.pragma('busy_timeout = 3000');
  // WAL 标准搭配：NORMAL 在多数崩溃场景与 FULL 持久性等同，写入吞吐更优
  sqlite.pragma('synchronous = NORMAL');

  // 启动完整性校验：损坏时提前暴露（替代崩溃后才发现）
  // P2 修复：simple:true 返回标量字符串（'ok' 或首个错误描述），此前
  // Array.isArray 判定恒为 false——损坏库也会打出「校验通过」（死代码判定）。
  // 用 quick_check 替代 integrity_check：跳过索引逐项交叉校验，启动开销更低。
  const integrity = sqlite.pragma('quick_check', { simple: true }) as unknown;
  if (typeof integrity === 'string' && integrity !== 'ok') {
    logger.error({ result: integrity }, 'SQLite 完整性校验失败，数据库可能已损坏');
    // 不阻断启动（只读场景仍可用），但明确记录供诊断
  } else {
    logger.info({}, 'SQLite 完整性校验通过');
  }

  // 启动时自动轮转备份（热备份，不中断服务）：保留最近 BACKUP_KEEP 份
  // 异步执行，不阻塞启动流程
  void backupDatabase(sqlite, dbPath).catch((error: unknown) => {
    logger.error({ error: String(error) }, '数据库备份失败');
  });

  // 创建 drizzle 实例
  const db = drizzle(sqlite, { schema });

  // 建表与迁移顺序（P1 修复：老库必须先补列、再执行 SCHEMA_SQL）：
  // SCHEMA_SQL 尾部包含 CREATE INDEX ... ON messages(turn_id)，若老库缺该列，
  // 先执行 SCHEMA_SQL 会在索引处抛「no such column」中断启动。
  // 因此以 sessions 表是否已存在区分两条路径：
  // - 全新库：直接执行最新 SCHEMA_SQL，落位当前版本
  // - 老库：先按版本链执行 pending 迁移（幂等），再执行 SCHEMA_SQL
  //   （此时建表/建索引全部 IF NOT EXISTS，no-op 或安全补齐）
  const hadSessionsTable =
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get() !==
    undefined;

  if (!hadSessionsTable) {
    sqlite.exec(SCHEMA_SQL);
    sqlite.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    logger.info({ toVersion: CURRENT_SCHEMA_VERSION }, '全新数据库，schema 落位当前版本');
  } else {
    // P4 修复：版本化迁移（PRAGMA user_version 版本链）替代启动期
    // 「ALTER + duplicate column name 字符串匹配」——后者无版本链、
    // 无回滚路径、错误判定依赖 SQLite 错误文案。列存在性检查保证幂等。
    const currentVersion = Number(sqlite.pragma('user_version', { simple: true }));
    if (currentVersion < CURRENT_SCHEMA_VERSION) {
      for (const migration of MIGRATIONS) {
        if (migration.version <= currentVersion) {
          continue;
        }
        sqlite.transaction(() => {
          migration.up(sqlite);
          sqlite.pragma(`user_version = ${migration.version}`);
        })();
        logger.info({ version: migration.version, name: migration.name }, '数据库迁移已应用');
      }
    }
    sqlite.exec(SCHEMA_SQL);
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
