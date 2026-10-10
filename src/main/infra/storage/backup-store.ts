import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { BackupEntry } from '@code-agent/shared/main';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import Database from 'better-sqlite3';
import { logger } from '../../utils/logger';

export const BACKUP_KEEP = 3;
export const BACKUP_DIR = 'backups';
export const RESTORE_PENDING_FILENAME = 'sessions.db.restore-pending';

const BACKUP_PREFIX = 'sessions-';

const BACKUP_NAME_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?$/;

export function backupDirPath(dbPath: string): string {
  return join(dirname(dbPath), BACKUP_DIR);
}

function restrictBackupPermissions(filePath: string): void {
  if (process.platform === 'win32') {
    return;
  }
  try {
    chmodSync(filePath, 0o600);
  } catch {}
}

export function listBackupNames(dbPath: string): string[] {
  try {
    return readdirSync(backupDirPath(dbPath))
      .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith('.db'))
      .sort();
  } catch {
    return [];
  }
}

function resolveCreatedAtMs(name: string, fullPath: string): number {
  const stamp = name.slice(BACKUP_PREFIX.length, -'.db'.length);
  const matched = stamp.match(BACKUP_NAME_PATTERN);
  if (matched !== null) {
    const millis = matched[5] ?? '000';
    const iso = `${matched[1]}T${matched[2]}:${matched[3]}:${matched[4]}.${millis}Z`;
    const parsed = Date.parse(iso);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  try {
    return statSync(fullPath).mtimeMs;
  } catch {
    return 0;
  }
}

export function isBackupHealthy(backupPath: string): boolean {
  const shmPath = `${backupPath}-shm`;
  const walPath = `${backupPath}-wal`;
  const shmExisted = existsSync(shmPath);
  const walExisted = existsSync(walPath);
  let probe: Database.Database | null = null;
  try {
    probe = new Database(backupPath, { readonly: true });
    const integrity = probe.pragma('quick_check', { simple: true }) as unknown;
    return !(typeof integrity === 'string' && integrity !== 'ok');
  } catch {
    return false;
  } finally {
    try {
      probe?.close();
    } catch {}
    if (!shmExisted) {
      try {
        unlinkSync(shmPath);
      } catch {}
    }
    if (!walExisted) {
      try {
        unlinkSync(walPath);
      } catch {}
    }
  }
}

export async function createBackupFile(sqlite: Database.Database, dbPath: string): Promise<string> {
  const backupDir = backupDirPath(dbPath);
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  const name = `${BACKUP_PREFIX}${stamp}.db`;
  const backupPath = join(backupDir, name);
  const tmpPath = `${backupPath}.tmp`;
  if (process.platform !== 'win32') {
    try {
      closeSync(openSync(tmpPath, 'a', 0o600));
    } catch {}
  }
  await sqlite.backup(tmpPath);
  restrictBackupPermissions(tmpPath);
  renameSync(tmpPath, backupPath);
  logger.info({ backupPath }, '数据库热备份完成');

  const backups = listBackupNames(dbPath);
  const excess = backups.length - BACKUP_KEEP;
  for (let i = 0; i < excess; i++) {
    const stale = join(backupDir, backups[i] ?? '');
    unlinkSync(stale);
    logger.info({ stale }, '轮转删除过期备份');
  }
  return name;
}

export function cleanupBackupTmpFiles(dbPath: string): void {
  try {
    for (const name of readdirSync(backupDirPath(dbPath))) {
      if (name.endsWith('.db.tmp')) {
        unlinkSync(join(backupDirPath(dbPath), name));
      }
    }
  } catch {}
}

export function listBackups(dbPath: string): BackupEntry[] {
  const dir = backupDirPath(dbPath);
  return listBackupNames(dbPath)
    .reverse()
    .map((name) => {
      const fullPath = join(dir, name);
      let sizeBytes = 0;
      try {
        sizeBytes = statSync(fullPath).size;
      } catch {}
      return {
        name,
        createdAtMs: resolveCreatedAtMs(name, fullPath),
        sizeBytes,
        healthy: isBackupHealthy(fullPath),
      };
    });
}

export function stageRestore(dbPath: string, name: string): void {
  if (name.length === 0 || name !== name.trim() || /[\\/]/.test(name) || name.includes('..')) {
    throw new AppError(ErrorCode.BACKUP_INVALID, `非法备份名：${name}`);
  }
  const source = join(backupDirPath(dbPath), name);
  if (!existsSync(source)) {
    throw new AppError(ErrorCode.BACKUP_INVALID, `备份不存在：${name}`);
  }
  if (!isBackupHealthy(source)) {
    throw new AppError(ErrorCode.BACKUP_INVALID, `备份损坏，无法恢复：${name}`);
  }
  const pendingPath = join(dirname(dbPath), RESTORE_PENDING_FILENAME);
  copyFileSync(source, pendingPath);
  restrictBackupPermissions(pendingPath);
  logger.warn({ from: source, pending: pendingPath }, '备份恢复已暂存（重启后生效）');
}

export function applyPendingRestore(dbPath: string): boolean {
  const pendingPath = join(dirname(dbPath), RESTORE_PENDING_FILENAME);
  if (!existsSync(pendingPath)) {
    return false;
  }
  logger.warn({ pendingPath, dbPath }, '检测到待应用备份恢复，启动期替换主库');
  for (const suffix of ['', '-wal', '-shm'] as const) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true });
    } catch (error) {
      logger.error(
        { suffix, error: error instanceof Error ? error.message : String(error) },
        '恢复应用：清理旧库文件失败',
      );
    }
  }
  renameSync(pendingPath, dbPath);
  restrictBackupPermissions(dbPath);
  logger.warn({ dbPath }, '备份恢复已应用（本次启动使用恢复点数据）');
  return true;
}
