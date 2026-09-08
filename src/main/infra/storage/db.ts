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
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { app } from 'electron';
import { logger } from '../../utils/logger';
import { schema } from './schema';

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
/** PRAGMA auto_vacuum 的 INCREMENTAL 取值（0=NONE 默认 / 1=FULL / 2=INCREMENTAL） */
const AUTO_VACUUM_INCREMENTAL = 2;
/**
 * freelist 达到该页数才做增量回收（默认页 4KB ⇒ 约 4MB）
 *
 * 阈值而非"每次删除后都跑"：incremental_vacuum 要遍历 freelist 并截断文件，
 * 放在每条删除路径上会让主进程为小改动反复付截断代价。
 */
const FREELIST_RECLAIM_PAGES = 1024;

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
    // 原子落盘：先写 .db.tmp 成功后再 rename。backup() 中途失败（磁盘满、进程被
    // 强杀）会留下半截文件，而轮转按 *.db 计数——残缺备份会被误当成可用恢复点。
    const tmpPath = `${backupPath}.tmp`;
    // 安全修复：先以 0600 预创建空文件再交给 sqlite.backup 截断写入——
    // 此前备份以默认 umask（644）完整落盘后才 chmod，POSIX 下存在
    // 其他进程读到明文对话历史的窗口期。openSync 'a' 不截断已存在文件。
    if (process.platform !== 'win32') {
      try {
        closeSync(openSync(tmpPath, 'a', 0o600));
      } catch {
        // 预创建失败不阻断（backup 会按原逻辑创建，restrictFilePermissions 兜底）
      }
    }
    await sqlite.backup(tmpPath);
    // 安全修复：备份含完整对话历史，同样限制为仅属主可读写
    restrictFilePermissions(tmpPath);
    renameSync(tmpPath, backupPath);
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
    // 失败清理：残缺的 .db.tmp 不留存（不匹配轮转的 .db 过滤，但避免目录堆积）
    const partial = join(dirname(dbPath), BACKUP_DIR);
    try {
      for (const name of readdirSync(partial)) {
        if (name.endsWith('.db.tmp')) {
          unlinkSync(join(partial, name));
        }
      }
    } catch {
      // 备份目录尚未创建，无残留可清
    }
    // 备份失败不阻断启动（日志中可诊断）
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      '数据库备份失败',
    );
  }
}

/**
 * 调度启动热备份（异步发起，不阻塞启动）
 *
 * 调用时机与条件（2026-09-06 审计修复）：
 * - **必须在 migrate 成功之后**：迁移前调度会让在途备份与迁移写在同一帧交错，
 *   快照一致性无保证
 * - **仅在库健康时**：备份按时间戳进入轮转环，BACKUP_KEEP 次重启后即把唯一
 *   健康的恢复点全部覆盖为损坏/空副本
 * - 完整性结论复用 restoreCorruptDatabase 的 quick_check（此前每启跑两遍全库扫描）
 */
function scheduleStartupBackup(
  sqlite: Database.Database,
  dbPath: string,
  status: RecoveryStatus,
): void {
  if (status === 'rebuilt') {
    logger.warn({}, '本次启动重建了空数据库，跳过启动备份以保留既有健康备份');
    return;
  }
  // backupDatabase 内部已捕获全部异常，此 Promise 永不 reject，可安全 await
  pendingBackup = backupDatabase(sqlite, dbPath).catch((error: unknown) => {
    logger.error({ error: String(error) }, '数据库备份失败');
  });
}

/**
 * 从最近健康备份恢复数据库文件（2026-09-04 新增：损坏自愈）
 *
 * 策略：从新到旧遍历 backups/ 轮转环，逐份 quick_check 验证，
 * 取第一份健康备份覆盖主库文件（并清理可能不匹配的 WAL/SHM 残件）。
 * 若轮转环全部损坏（极端情况）返回 false。
 */
function tryRestoreFromBackup(dbPath: string): boolean {
  const backupDir = join(dirname(dbPath), BACKUP_DIR);
  let backups: string[];
  try {
    backups = readdirSync(backupDir)
      .filter((name) => name.startsWith('sessions-') && name.endsWith('.db'))
      .sort();
  } catch {
    // 备份目录不存在（从未成功备份）
    return false;
  }
  if (backups.length === 0) {
    return false;
  }
  // 从新到旧：优先最新健康备份（数据最新）
  for (const name of [...backups].reverse()) {
    const candidate = join(backupDir, name);
    try {
      const probe = new Database(candidate, { readonly: true });
      const integrity = probe.pragma('quick_check', { simple: true }) as unknown;
      probe.close();
      const healthy = !(typeof integrity === 'string' && integrity !== 'ok');
      if (!healthy) {
        logger.warn({ backup: name }, '备份完整性校验失败，尝试更早备份');
        continue;
      }
      // 覆盖主库（先清 WAL/SHM 残件：旧日志与恢复文件不匹配，SQLite 会误读）
      for (const suffix of ['', '-wal', '-shm'] as const) {
        try {
          rmSync(`${dbPath}${suffix}`, { force: true });
        } catch {
          // 忽略清理失败（文件可能被占用，copyFileSync 随后抛错会走 catch）
        }
      }
      copyFileSync(candidate, dbPath);
      restrictFilePermissions(dbPath);
      logger.warn({ from: candidate }, '已从备份恢复数据库文件');
      return true;
    } catch (error) {
      // 备份文件损坏/不可读：尝试更早一份
      logger.warn(
        { backup: name, error: error instanceof Error ? error.message : String(error) },
        '备份恢复尝试失败',
      );
    }
  }
  return false;
}

/** 损坏自愈结论：healthy=原库健康；restored=已从备份恢复；rebuilt=已重建空库 */
type RecoveryStatus = 'healthy' | 'restored' | 'rebuilt';

/** 自愈结论 + 可用连接（调用方据 status 决定是否调度启动备份） */
interface RecoveryOutcome {
  readonly sqlite: Database.Database;
  readonly status: RecoveryStatus;
}

/**
 * 数据库损坏自愈（quick_check 失败 → 恢复/重建）
 *
 * @param sqlite 当前（已打开但可能损坏的）连接
 * @param dbPath 数据库文件路径
 * @returns 可用连接 + 结论状态（healthy 时原样返回入参连接）
 *
 * 策略：
 * 1. quick_check 通过 → 返回 null（健康，不动作）
 * 2. 损坏 → 从最近健康备份恢复并重开连接（返回新连接，走默认 pragma）
 * 3. 无健康备份 → 将损坏文件归档为 *.corrupt-<ts>（保留诊断），重建空库保启动
 *    （对齐 VS Code 设置损坏重建语义：丢数据但应用可继续用）
 */
function restoreCorruptDatabase(sqlite: Database.Database, dbPath: string): RecoveryOutcome {
  const integrity = sqlite.pragma('quick_check', { simple: true }) as unknown;
  const healthy = !(typeof integrity === 'string' && integrity !== 'ok');
  if (healthy) {
    logger.info({}, 'SQLite 完整性校验通过');
    return { sqlite, status: 'healthy' };
  }
  logger.error({ result: integrity }, 'SQLite 完整性校验失败，进入损坏自愈流程');
  sqlite.close();

  if (tryRestoreFromBackup(dbPath)) {
    const reopened = new Database(dbPath);
    applyDefaultPragmas(reopened, dbPath);
    return { sqlite: reopened, status: 'restored' };
  }

  // 无健康备份：归档损坏文件（保留人工诊断可能性），重建空库保启动
  const corruptPath = `${dbPath}.corrupt-${Date.now()}`;
  try {
    renameSync(dbPath, corruptPath);
    logger.error({ corruptPath }, '数据库损坏且无可用备份，已归档损坏文件');
  } catch (error) {
    // 归档失败（文件被占用等）：直接建空库（覆盖）
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      '损坏数据库归档失败，直接重建',
    );
  }
  const fresh = new Database(dbPath);
  restrictFilePermissions(dbPath);
  applyDefaultPragmas(fresh, dbPath);
  logger.warn({}, '已重建空数据库（前提数据已归档，后续迁移建表）');
  return { sqlite: fresh, status: 'rebuilt' };
}

/**
 * 应用默认 pragma（打开连接后统一调用）
 *
 * 集中化：initDb 与损坏恢复（restoreCorruptDatabase 重开连接）共用，
 * 避免两处 pragma 漂移。
 */
function applyDefaultPragmas(sqlite: Database.Database, dbPath: string): void {
  // 启用 WAL 模式（Write-Ahead Logging）：提升并发读性能
  sqlite.pragma('journal_mode = WAL');
  restrictFilePermissions(`${dbPath}-wal`);
  restrictFilePermissions(`${dbPath}-shm`);
  // 启用外键约束（SQLite 默认关闭，drizzle schema 中 references 依赖此）
  sqlite.pragma('foreign_keys = ON');
  // P2：外部工具（drizzle-kit studio / sqlite CLI）占用库文件时短暂等待
  sqlite.pragma('busy_timeout = 3000');
  // WAL 标准搭配：NORMAL 在多数崩溃场景与 FULL 持久性等同，写入吞吐更优
  sqlite.pragma('synchronous = NORMAL');
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
 * 在途启动备份 Promise（无则在 idle）
 *
 * 备份是异步的，关闭连接前必须等待它落地——否则备份会在连接已关闭后继续写
 * 临时文件，产出截断的备份副本混入轮转环（看似健康的假恢复点）。
 */
let pendingBackup: Promise<void> | null = null;

/**
 * 极老库兼容补丁：迁移前为 runtime_models 补齐缺失列（幂等）
 *
 * 背景（2026-08-27 生产库实测暴露）：手写 schema-sql.ts 时代早期创建的库，
 * runtime_models 只有 model_id/provider_kind/base_url/created_at 4 列——
 * 后来新增的 display_name/is_enabled 只随 CREATE TABLE IF NOT EXISTS 落在
 * 新库，老库从未 ALTER。迁移 0001 的 INSERT...SELECT 显式列举全列 →
 * 极老库报 "no such column: display_name"，整批迁移回滚，应用启动失败。
 * 此处按 pragma table_info 探测缺列并 ALTER 补齐，使 0001 可正常执行。
 */
function normalizeLegacyRuntimeModels(sqlite: Database.Database): void {
  const table = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_models'")
    .get();
  // 表不存在：全新库由 0000 基线直接建出完整定义，无需补丁
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

/**
 * 解析 drizzle 迁移目录
 *
 * - dev / 测试：仓库根 drizzle/（drizzle-kit generate 的产物，入仓管理）；
 *   启动方式导致 getAppPath() 非仓库根时（如 electron 直接执行入口文件），
 *   按候选路径探测回退（见实现）
 * - 打包环境：resources/drizzle（electron-builder extraResources 复制）
 */
function resolveMigrationsDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'drizzle');
  }
  // dev / E2E：app.getAppPath() 随启动方式变化——`electron .` 为仓库根，
  // 但 `electron out/main/index.js`（Playwright _electron.launch 即如此）会
  // 返回入口文件目录 out/main，导致 drizzle 目录解析丢失（2026-08-27 实测）。
  // 按优先级探测候选路径，取首个含 meta/_journal.json 的有效目录。
  const candidates = [
    join(app.getAppPath(), 'drizzle'),
    join(process.cwd(), 'drizzle'),
    // appPath 为 out/main 时，上溯两级即仓库根（与 electron-vite 产物布局对齐）
    join(app.getAppPath(), '..', '..', 'drizzle'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'meta', '_journal.json'))) {
      return dir;
    }
  }
  return candidates[0] as string;
}

/**
 * 初始化数据库
 *
 * 流程：
 * 1. 确保 userData 目录存在（mkdirSync recursive）
 * 2. 打开 better-sqlite3 连接（同步）
 * 3. 配置 WAL 模式（提升并发读性能）
 * 4. 创建 drizzle 实例
 * 5. 执行 drizzle-kit 生成的迁移（schema.ts 单一真源自动派生，幂等）
 *
 * 启动顺序（2026-09-06 审计修复）：
 * - **先损坏自愈再 VACUUM**：损坏库上任何写操作（含 VACUUM）都会先抛
 *   SQLITE_CORRUPT，把 auto_vacuum 转换放在前面会让自愈永远走不到
 *   （auto_vacuum=NONE 的老库一旦损坏 = 每次启动即死，健康备份形同虚设）
 * - **迁移成功后才调度备份**：空库被备份会按时间戳挤掉轮转环里唯一健康的恢复点
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
  let sqlite: Database.Database = new Database(dbPath);
  // 安全修复：限制数据库文件权限为仅属主可读写（含后续 WAL/SHM 伴随文件）
  restrictFilePermissions(dbPath);
  // 统一默认 pragma（WAL / 外键 / busy_timeout / synchronous）
  applyDefaultPragmas(sqlite, dbPath);

  // 启动顺序见函数头注释：自愈 → auto_vacuum → 迁移 → 备份
  const recovery = restoreCorruptDatabase(sqlite, dbPath);
  sqlite = recovery.sqlite;
  // 空间回收前提：一次性 VACUUM 必须在启动备份之前（否则与在途热备份抢同一份页）
  ensureIncrementalAutoVacuum(sqlite);

  // 创建 drizzle 实例
  const db = drizzle(sqlite, { schema });

  // 极老库兼容：迁移前补齐 runtime_models 缺失列（幂等，新库/已迁移库无操作）
  normalizeLegacyRuntimeModels(sqlite);

  // 执行 drizzle-kit 生成的迁移（schema.ts 单一真源自动派生）：
  // - migrate() 维护 __drizzle_migrations journal 表，幂等执行未应用的迁移
  // - 全新库：应用基线迁移（建全部表/索引/约束）落位当前版本
  // - 老库：仅应用 journal 中缺失的增量迁移
  const migrationsDir = resolveMigrationsDir();
  try {
    migrate(db, { migrationsFolder: migrationsDir });
    logger.info({ migrationsDir }, 'SQLite 迁移已应用');
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), migrationsDir },
      'SQLite 迁移执行失败（迁移目录缺失或损坏）',
    );
    // 迁移失败时关闭已打开的 SQLite 连接（测试/重试场景防句柄泄漏；
    // 生产路径由 index.ts 启动失败 → app.exit 兜底）
    try {
      sqlite.close();
    } catch {
      // ignore
    }
    throw error;
  }

  // 备份调度：迁移成功后 + 非空库重建（结论复用自愈阶段的 quick_check）
  scheduleStartupBackup(sqlite, dbPath, recovery.status);

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
 * 确保库处于 auto_vacuum=INCREMENTAL（幂等，仅首次需要一次 VACUUM）
 *
 * 缺陷背景：SQLite 默认 auto_vacuum=NONE，DELETE 释放的页只进 freelist，
 * 文件永不缩小——实测 20000 行消息删掉 90% 后文件仍为 82.47MB
 * （freelist 9016 / page_count 10025）。且 NONE 模式下 `PRAGMA incremental_vacuum`
 * 是空操作（实测 freed_pages=0），所以光加回收调用并不能修复，必须先转换模式。
 *
 * 已有表的库仅改 pragma 不生效，必须跟随一次 VACUUM 重写页布局
 * （实测 82MB 库 35ms，之后 auto_vacuum 持久记在文件头，只付一次）。
 */
function ensureIncrementalAutoVacuum(sqlite: Database.Database): void {
  const current = Number(sqlite.pragma('auto_vacuum', { simple: true }));
  if (current === AUTO_VACUUM_INCREMENTAL) {
    return;
  }
  const startedAt = Date.now();
  sqlite.pragma('auto_vacuum = INCREMENTAL');
  // VACUUM 是 SQL 语句而非 PRAGMA：`pragma('vacuum')` 会被当作未知 pragma 静默忽略
  sqlite.exec('VACUUM');
  logger.info(
    { from: current, ms: Date.now() - startedAt },
    'SQLite auto_vacuum 已转换为 INCREMENTAL（一次性）',
  );
}

/**
 * 把 freelist 空闲页归还给磁盘
 *
 * 由删除路径在批量删除后调用（会话级联删除、统计窗口清理）。未达
 * {@link FREELIST_RECLAIM_PAGES} 阈值时直接返回 0，避免小改动反复截断。
 *
 * WAL 模式下必须跟一次 checkpoint：incremental_vacuum 只更新主库页布局，
 * 被释放的字节仍留在 -wal 中，不做 checkpoint 磁盘占用不会下降。
 *
 * @returns 归还给磁盘的页数
 * @throws Error 数据库未初始化
 */
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

/**
 * 关闭数据库连接
 *
 * 应用退出时调用，释放 SQLite 文件句柄。
 * WAL 模式下关闭会自动 checkpoint（合并 WAL 到主数据库）。
 *
 * 关闭前先等待在途启动备份落地：备份若继续跑在已关闭的连接上会产出截断副本，
 * 而轮转按 *.db 计数——假恢复点比没有备份更危险。
 *
 * 幂等：多次调用安全。
 */
export async function closeDb(): Promise<void> {
  if (pendingBackup !== null) {
    await pendingBackup;
    pendingBackup = null;
  }
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
