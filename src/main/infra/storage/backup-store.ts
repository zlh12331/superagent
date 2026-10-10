// backup-store.ts：数据库备份存储——热备份轮转（保留 3 份）、健康校验、恢复暂存/应用
// 恢复两段式：stageRestore 暂存文件（本进程持有 DB 无法原地替换）→ 下次启动 applyPendingRestore 真替换
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

// 轮转保留份数：3 份 × 毫秒级命名，同秒多次备份靠毫秒段防覆盖（37 号实测教训）
export const BACKUP_KEEP = 3;
export const BACKUP_DIR = 'backups';
// 恢复暂存文件名：下次启动 initDb 检测到它才执行真替换
export const RESTORE_PENDING_FILENAME = 'sessions.db.restore-pending';

const BACKUP_PREFIX = 'sessions-';

// 备份名时间戳格式：ISO 冒号换成连字符（Windows 文件名非法字符）；毫秒段可选（老备份无）
const BACKUP_NAME_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?$/;

/** 备份目录：<userData>/backups */
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

// 创建时间优先从文件名时间戳解析（毫秒级、可靠）；老格式解析不出回落文件 mtime
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

/**
 * 备份健康校验：只读打开 + quick_check
 *
 * 探针打开会伴生 -shm/-wal 伴生文件——finally 里把「原来不存在」的清掉，
 * 否则每次校验都在备份目录里留垃圾（37 号实测污染修复）
 */
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

/** 热备份：backup() 写 .tmp → rename 原子落盘（写一半崩溃不留半截备份）→ 轮转删超额 */
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

/** 清理备份目录里的 .db.tmp 残片（上次备份中断产物；备份失败兜底调用） */
export function cleanupBackupTmpFiles(dbPath: string): void {
  try {
    for (const name of readdirSync(backupDirPath(dbPath))) {
      if (name.endsWith('.db.tmp')) {
        unlinkSync(join(backupDirPath(dbPath), name));
      }
    }
  } catch {}
}

/** 备份列表（新→旧，含健康标记；设置面备份页消费） */
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

/**
 * 暂存恢复：备份名校验（防路径穿越——用户可控字符串只当文件名用）→ 存在性 + 健康校验 →
 * 拷为 restore-pending 暂存文件（真替换留给下次启动）
 */
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

/**
 * 应用待执行恢复（initDb 启动序第一步）：清 db/-wal/-shm 后 rename 暂存文件为真身
 *
 * @returns 是否执行了恢复（false = 无暂存，正常启动）
 */
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
