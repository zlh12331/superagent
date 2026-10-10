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
const AUTO_VACUUM_INCREMENTAL = 2;
const FREELIST_RECLAIM_PAGES = 1024;

function restrictFilePermissions(filePath: string): void {
  if (process.platform === 'win32') {
    restrictFileAccessWin32(filePath);
    return;
  }
  try {
    chmodSync(filePath, 0o600);
  } catch {}
}

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

type RecoveryStatus = 'healthy' | 'restored' | 'rebuilt';

interface RecoveryOutcome {
  readonly sqlite: Database.Database;
  readonly status: RecoveryStatus;
}

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

export function getDb(): DrizzleDB {
  if (dbInstance === null) {
    throw new Error('数据库未初始化，请先调用 initDb()');
  }
  return dbInstance;
}

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

export async function drainPendingBackups(): Promise<void> {
  const tail = pendingBackup;
  if (tail !== null) {
    await tail;
    if (pendingBackup === tail) {
      pendingBackup = null;
    }
  }
}

export async function closeDb(): Promise<void> {
  await drainPendingBackups();
  if (sqliteInstance !== null) {
    sqliteInstance.close();
    sqliteInstance = null;
    dbInstance = null;
    logger.info({}, 'SQLite 数据库连接已关闭');
  }
}

export function resetDb(): void {
  dbInstance = null;
  sqliteInstance = null;
}
