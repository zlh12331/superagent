// db.ts：SQLite 连接初始化 + 启动备份 + 损坏自愈——better-sqlite3 承载 Drizzle ORM
// 启动序：应用暂存恢复 → 打开/自愈（quick_check → 备份回滚 → 归档重建）→ pragma → 迁移 → 调度启动备份
// 边界：schema 真源在 schema.ts，迁移文件由 drizzle-kit 从其派生，本文件不写任何建表 SQL
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { app } from 'electron';
import { logger } from '../../utils/logger';
import {
  applyPendingRestore,
  backupDirPath,
  cleanupBackupTmpFiles,
  createBackupFile,
  isBackupHealthy,
  listBackupNames,
} from './backup-store';
import { restrictFileAccessWin32 } from './keychain';
import { schema } from './schema';

const DB_FILENAME = 'sessions.db';
// SQLite pragma 值：2 = INCREMENTAL（自动空间回收不开全库 VACUUM）
const AUTO_VACUUM_INCREMENTAL = 2;
// 空闲页低于此数不做 incremental_vacuum：VACUUM 有 IO 代价，零头不值得
const FREELIST_RECLAIM_PAGES = 1024;

// 文件权限收紧：win32 走 ACL（restrictFileAccessWin32），unix 0600（失败静默——只影响本用户文件）
function restrictFilePermissions(filePath: string): void {
  if (process.platform === 'win32') {
    restrictFileAccessWin32(filePath);
    return;
  }
  try {
    chmodSync(filePath, 0o600);
  } catch {}
}

// 备份串行化：better-sqlite3 的 backup() 是异步 API，并发备份会互相踩——
// 已有 pending 时链在其后执行，全程只保留一条备份链尾
function runBackup(sqlite: Database.Database, dbPath: string): Promise<void> {
  const run = (): Promise<void> =>
    createBackupFile(sqlite, dbPath)
      .then(() => undefined)
      .catch((error: unknown) => {
        cleanupBackupTmpFiles(dbPath);
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          '数据库备份失败',
        );
      });
  const task = pendingBackup !== null ? pendingBackup.then(run, run) : run();
  pendingBackup = task;
  return task;
}

/** 手动备份（设置面触发）：先排干挂起备份再执行，防并发 */
export async function createManualBackup(): Promise<{ readonly name: string }> {
  if (pendingBackup !== null) {
    await pendingBackup;
  }
  if (sqliteInstance === null) {
    throw new Error('数据库未初始化，无法备份');
  }
  const dbPath = getDbPath();
  const name = await createBackupFile(sqliteInstance, dbPath);
  return { name };
}

// 重建分支跳过启动备份：空库若进备份轮转，会把仅有的健康备份挤掉——保留它们等下次真实数据
function scheduleStartupBackup(
  sqlite: Database.Database,
  dbPath: string,
  status: RecoveryStatus,
): void {
  if (status === 'rebuilt') {
    logger.warn({}, '本次启动重建了空数据库，跳过启动备份以保留既有健康备份');
    return;
  }
  void runBackup(sqlite, dbPath);
}

// 从最新到最旧逐个尝试恢复：候选须过完整性校验；替换前先清 db/-wal/-shm 三件套
//（旧 wal 与恢复后的主库不匹配会再次损坏）
function tryRestoreFromBackup(dbPath: string): boolean {
  const backupDir = backupDirPath(dbPath);
  const backups = listBackupNames(dbPath);
  if (backups.length === 0) {
    return false;
  }
  for (const name of [...backups].reverse()) {
    const candidate = join(backupDir, name);
    try {
      if (!isBackupHealthy(candidate)) {
        logger.warn({ backup: name }, '备份完整性校验失败，尝试更早备份');
        continue;
      }
      for (const suffix of ['', '-wal', '-shm'] as const) {
        try {
          rmSync(`${dbPath}${suffix}`, { force: true });
        } catch {}
      }
      copyFileSync(candidate, dbPath);
      restrictFilePermissions(dbPath);
      logger.warn({ from: candidate }, '已从备份恢复数据库文件');
      return true;
    } catch (error) {
      logger.warn(
        { backup: name, error: error instanceof Error ? error.message : String(error) },
        '备份恢复尝试失败',
      );
    }
  }
  return false;
}

/** 自愈结局：healthy=原库无恙 / restored=备份恢复 / rebuilt=归档后重建空库（迁移随后建表） */
type RecoveryStatus = 'healthy' | 'restored' | 'rebuilt';

interface RecoveryOutcome {
  readonly sqlite: Database.Database;
  readonly status: RecoveryStatus;
}

// 损坏自愈三级：quick_check 健康即用 → 从备份恢复 → 无备份则归档损坏文件（.corrupt-时间戳）
// 后重建空库（数据不静默丢弃，归档可人工找回）
function restoreCorruptDatabase(sqlite: Database.Database | null, dbPath: string): RecoveryOutcome {
  if (sqlite !== null) {
    let integrity: unknown;
    try {
      integrity = sqlite.pragma('quick_check', { simple: true }) as unknown;
    } catch (error) {
      integrity = error instanceof Error ? error.message : String(error);
    }
    const healthy = !(typeof integrity === 'string' && integrity !== 'ok');
    if (healthy) {
      logger.info({}, 'SQLite 完整性校验通过');
      return { sqlite, status: 'healthy' };
    }
    logger.error({ result: integrity }, 'SQLite 完整性校验失败，进入损坏自愈流程');
    try {
      sqlite.close();
    } catch {}
  } else {
    logger.error({ dbPath }, '数据库打开阶段失败，进入损坏自愈流程');
  }

  if (tryRestoreFromBackup(dbPath)) {
    const reopened = new Database(dbPath);
    applyDefaultPragmas(reopened, dbPath);
    return { sqlite: reopened, status: 'restored' };
  }

  const corruptPath = `${dbPath}.corrupt-${Date.now()}`;
  try {
    renameSync(dbPath, corruptPath);
    logger.error({ corruptPath }, '数据库损坏且无可用备份，已归档损坏文件');
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      '损坏数据库归档失败，直接重建',
    );
  }
  for (const suffix of ['-wal', '-shm']) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {}
  }
  const fresh = new Database(dbPath);
  restrictFilePermissions(dbPath);
  applyDefaultPragmas(fresh, dbPath);
  logger.warn({}, '已重建空数据库（前提数据已归档，后续迁移建表）');
  return { sqlite: fresh, status: 'rebuilt' };
}

// 标准档 pragma：WAL（读写并发）+ 外键强制 + 3s busy 等待（并发写偶发锁）+ NORMAL 同步
//（WAL 下 NORMAL 已足够安全且快）；wal/shm 文件权限同步收紧
function applyDefaultPragmas(sqlite: Database.Database, dbPath: string): void {
  sqlite.pragma('journal_mode = WAL');
  restrictFilePermissions(`${dbPath}-wal`);
  restrictFilePermissions(`${dbPath}-shm`);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 3000');
  sqlite.pragma('synchronous = NORMAL');
}

export function getDbPath(): string {
  const userDataPath = app.getPath('userData');
  return join(userDataPath, DB_FILENAME);
}

type DrizzleDB = BetterSQLite3Database<typeof schema>;

let dbInstance: DrizzleDB | null = null;

let sqliteInstance: Database.Database | null = null;

let pendingBackup: Promise<void> | null = null;

// 极老库形态补丁：display_name/is_enabled 列诞生于 drizzle 迁移链基线之前，
// 迁移文件覆盖不到，只能在迁移执行前手动 ALTER（存在性探测后才补，幂等）
function normalizeLegacyRuntimeModels(sqlite: Database.Database): void {
  const table = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_models'")
    .get();
  if (table === undefined) return;

  const columns = new Set(
    (sqlite.prepare('PRAGMA table_info(runtime_models)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  if (!columns.has('display_name')) {
    sqlite.exec('ALTER TABLE runtime_models ADD COLUMN display_name TEXT');
    logger.info({}, 'runtime_models 极老库补丁：补齐 display_name 列');
  }
  if (!columns.has('is_enabled')) {
    sqlite.exec('ALTER TABLE runtime_models ADD COLUMN is_enabled INTEGER NOT NULL DEFAULT 1');
    logger.info({}, 'runtime_models 极老库补丁：补齐 is_enabled 列');
  }
}

// 迁移目录三候选：打包态在 resources（extraResources）；dev 因 pnpm 启动 cwd 不定，
// 依次试 appPath/cwd/上两级，以 meta/_journal.json 存在为准
function resolveMigrationsDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'drizzle');
  }
  const candidates = [
    join(app.getAppPath(), 'drizzle'),
    join(process.cwd(), 'drizzle'),
    join(app.getAppPath(), '..', '..', 'drizzle'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'meta', '_journal.json'))) {
      return dir;
    }
  }
  return candidates[0] as string;
}

// 打开即配好 pragma 并收紧权限；打开阶段失败返回 null 交给自愈流程（而非直接炸启动）
function openWithDefaultPragmas(dbPath: string): Database.Database | null {
  let sqlite: Database.Database | null = null;
  try {
    sqlite = new Database(dbPath);
    restrictFilePermissions(dbPath);
    applyDefaultPragmas(sqlite, dbPath);
    return sqlite;
  } catch (openError: unknown) {
    logger.error(
      { dbPath, error: openError instanceof Error ? openError.message : String(openError) },
      '数据库打开/pragma 失败，转入损坏自愈流程',
    );
    try {
      sqlite?.close();
    } catch {}
    return null;
  }
}

/**
 * 初始化数据库（应用级单例，whenReady 启动序列调用）：
 * 暂存恢复 → 损坏自愈 → auto_vacuum 对齐 → 极老库补丁 → 迁移 → 调度启动备份
 */
export function initDb(): DrizzleDB {
  if (dbInstance !== null) {
    return dbInstance;
  }

  const dbPath = getDbPath();
  const dir = join(dbPath, '..');
  mkdirSync(dir, { recursive: true });

  logger.info({ dbPath }, '初始化 SQLite 数据库');

  try {
    applyPendingRestore(dbPath);
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      '备份恢复应用失败（暂存保留，下次启动重试；继续按现有库启动）',
    );
  }

  const recovery = restoreCorruptDatabase(openWithDefaultPragmas(dbPath), dbPath);
  const sqlite = recovery.sqlite;
  ensureIncrementalAutoVacuum(sqlite);

  const db = drizzle(sqlite, { schema });

  normalizeLegacyRuntimeModels(sqlite);

  const migrationsDir = resolveMigrationsDir();
  try {
    migrate(db, { migrationsFolder: migrationsDir });
    logger.info({ migrationsDir }, 'SQLite 迁移已应用');
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), migrationsDir },
      'SQLite 迁移执行失败（迁移目录缺失或损坏）',
    );
    try {
      sqlite.close();
    } catch {}
    throw error;
  }

  scheduleStartupBackup(sqlite, dbPath, recovery.status);

  dbInstance = db;
  sqliteInstance = sqlite;
  logger.info({ dbPath }, 'SQLite 数据库初始化完成');
  return db;
}

/** 取 Drizzle 实例（未初始化即抛——调用时序错误要炸得早） */
export function getDb(): DrizzleDB {
  if (dbInstance === null) {
    throw new Error('数据库未初始化，请先调用 initDb()');
  }
  return dbInstance;
}

// auto_vacuum 模式切换必须伴一次全量 VACUUM 才生效（SQLite 限制）——旧库首次升级时一次性执行
function ensureIncrementalAutoVacuum(sqlite: Database.Database): void {
  const current = Number(sqlite.pragma('auto_vacuum', { simple: true }));
  if (current === AUTO_VACUUM_INCREMENTAL) {
    return;
  }
  const startedAt = Date.now();
  sqlite.pragma('auto_vacuum = INCREMENTAL');
  sqlite.exec('VACUUM');
  logger.info(
    { from: current, ms: Date.now() - startedAt },
    'SQLite auto_vacuum 已转换为 INCREMENTAL（一次性）',
  );
}

/** 归还空闲页磁盘空间（freelist 过阈值才动手）；@returns 释放的页数 */
export function reclaimFreePages(): number {
  if (sqliteInstance === null) {
    throw new Error('数据库未初始化，请先调用 initDb()');
  }
  const freelist = Number(sqliteInstance.pragma('freelist_count', { simple: true }));
  if (freelist < FREELIST_RECLAIM_PAGES) {
    return 0;
  }
  const before = Number(sqliteInstance.pragma('page_count', { simple: true }));
  sqliteInstance.pragma('incremental_vacuum');
  sqliteInstance.pragma('wal_checkpoint(TRUNCATE)');
  const freed = before - Number(sqliteInstance.pragma('page_count', { simple: true }));
  if (freed > 0) {
    logger.info({ freed, pagesBefore: before }, 'SQLite 空闲页已归还磁盘');
  }
  return freed;
}

/** 等待挂起的启动备份完成（退出链 closeDb 前调用，防备份写一半进程就没了） */
export async function drainPendingBackups(): Promise<void> {
  const tail = pendingBackup;
  if (tail !== null) {
    await tail;
    if (pendingBackup === tail) {
      pendingBackup = null;
    }
  }
}

/** 优雅关闭：排干备份 → 关连接（dispose 链最后一步，DB 必须最后关） */
export async function closeDb(): Promise<void> {
  await drainPendingBackups();
  if (sqliteInstance !== null) {
    sqliteInstance.close();
    sqliteInstance = null;
    dbInstance = null;
    logger.info({}, 'SQLite 数据库连接已关闭');
  }
}

/** 仅清单例引用不关连接（测试重置用；生产关闭走 closeDb） */
export function resetDb(): void {
  dbInstance = null;
  sqliteInstance = null;
}
