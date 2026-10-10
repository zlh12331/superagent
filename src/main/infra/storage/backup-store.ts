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

/** 备份保留份数（自动轮转，保留最近 N 份；与 db.ts 原值一致） */
export const BACKUP_KEEP = 3;
/** 备份目录名（位于 userData 下） */
export const BACKUP_DIR = 'backups';
/** 恢复暂存文件名（与主库同目录；启动期 applyPendingRestore 消费后消失） */
export const RESTORE_PENDING_FILENAME = 'sessions.db.restore-pending';

/** 备份文件命名前缀（轮转环过滤条件） */
const BACKUP_PREFIX = 'sessions-';

/**
 * 文件名时间戳正则（sessions-2026-09-30T04-00-00-123.db 形态；
 * ISO 的 ':' / '.' 在文件名中被替换为 '-'；毫秒段可选以兼容旧版秒精度命名）
 */
const BACKUP_NAME_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?$/;

/** 备份目录绝对路径 */
export function backupDirPath(dbPath: string): string {
  return join(dirname(dbPath), BACKUP_DIR);
}

/**
 * 限制备份文件权限为仅属主可读写（POSIX chmod 0600）
 *
 * Windows 侧备份文件的 ACL 由父目录（userData 下 %APPDATA%）默认 ACL 保障，
 * 与主库的 icacls 收紧口径存在差异——接受（备份目录不额外导出，且 Win32
 * 默认 ACL 已限定当前用户可写）。权限设置失败不阻断（只读文件系统等场景）。
 */
function restrictBackupPermissions(filePath: string): void {
  if (process.platform === 'win32') {
    return;
  }
  try {
    chmodSync(filePath, 0o600);
  } catch {}
}

/** 备份文件名列表（旧→新；目录不存在返回空数组。导出供 db.ts 自愈链复用） */
export function listBackupNames(dbPath: string): string[] {
  try {
    return readdirSync(backupDirPath(dbPath))
      .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith('.db'))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 文件名时间戳 → epoch ms
 *
 * 命名形态 sessions-2026-09-30T04-00-00-123.db（毫秒可选）；解析失败回落
 * 文件 mtime；均失败回落 0。
 */
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
 * 备份文件完整性校验（quick_check === ok）
 *
 * 与 db.ts 自愈链同一判据：无法打开/校验失败一律视为不健康（不可用于恢复）。
 *
 * 伴生文件副作用（2026-09-30 实测）：WAL 模式的库文件被只读打开时，SQLite 会在
 * 同目录新建 `-shm`/`-wal` 伴生文件（immutable URI 在 better-sqlite3 下不可用，
 * 实测 unable to open）。备份 .db 是 sqlite.backup() 产出的自包含快照，其伴生
 * 文件只可能由本探针产生（无真实数据）——探针结束后清理「本次新建」的那两个
 * （探针前已存在的旧残留不动：非本函数产物，保守不删）。
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

/**
 * 创建热备份文件（原子落盘 + 权限 + 轮转删除最旧）
 *
 * 流程与自愈语义：
 * - 先写 .db.tmp 成功后再 rename（backup() 中途失败会留下半截文件，
 *   而轮转按 *.db 计数——残缺备份会被误当成可用恢复点）
 * - 权限：POSIX 下先以 0600 预创建 tmp，避免落盘后到 chmod 之间的明文窗口
 * - 轮转：超出 BACKUP_KEEP 的最旧备份删除
 *
 * @returns 新备份文件名（裸名）
 * @throws Error 备份失败（磁盘满/权限等），由调用方决定上报形态
 */
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

/** 清理备份目录内的 .db.tmp 残片（备份失败后的收尾） */
export function cleanupBackupTmpFiles(dbPath: string): void {
  try {
    for (const name of readdirSync(backupDirPath(dbPath))) {
      if (name.endsWith('.db.tmp')) {
        unlinkSync(join(backupDirPath(dbPath), name));
      }
    }
  } catch {}
}

/**
 * 列出恢复点（最新在前；含 quick_check 健康度）
 *
 * 目录不存在/为空 → 空数组（两语义合并：调用方按空态展示）。
 */
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
 * 把指定恢复点暂存为「下次启动生效」的替换文件
 *
 * 防御：name 必须是裸文件名且落在备份目录内（路径穿越拒绝）；恢复点必须
 * 存在且 quick_check 健康（损坏备份拒绝——恢复后同样起不来还有数据风险）。
 *
 * @throws AppError(BACKUP_INVALID) 路径非法 / 备份不存在 / 备份损坏
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
 * 启动期应用暂存的恢复（initDb 顶部调用，连接打开之前）
 *
 * 语义：暂存存在 → 删除主库及 WAL/SHM 残件 → rename 暂存为正式库文件。
 * rename 保证「消费即消失」：连续两次启动不会重复应用；应用失败时暂存保留
 * （下次启动重试），并抛出由调用方决定是否阻断启动。
 *
 * @returns 是否应用了恢复
 * @throws Error 替换过程失败（由 initDb 决定处理；主库可能已删除，需人工介入）
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
