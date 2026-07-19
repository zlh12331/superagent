// src/main/infra/pg/pg-installer.ts
// PostgreSQL 初始化模块（设计文档 §6.5 AGE 兼容性策略 + §1.2 决策 3）
//
// 职责：
// 1. 检测数据目录是否已初始化（PG_VERSION 文件存在）
// 2. 未初始化时调用 initdb 创建数据目录
// 3. 提供 postgres 二进制路径（dev: 系统 PATH；prod: resources/pg/<version>/bin/）
// 4. AGE 兼容性降级编排（18.4 失败 → 切换 17.10，迁移数据目录）
//
// 注意：本模块不启动 PG（由 pg-controller.start() 负责）

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, ErrorCode, POSTGRES_VERSIONS } from '@novel-writer/shared';
import { app } from 'electron';
import { getAppConfig } from '../../config';
import { logger } from '../../utils/logger';
import { getUserDataPath } from '../storage/app-data';

/** PG 数据目录标识文件（initdb 完成后会创建此文件，含 PG 主版本号） */
const PG_VERSION_FILE = 'PG_VERSION';

/** 默认 PG 版本（AGE 在此版本通常已兼容） */
const DEFAULT_VERSION = POSTGRES_VERSIONS.V18_4;

/** 降级 PG 版本（AGE 兼容性兜底） */
const FALLBACK_VERSION = POSTGRES_VERSIONS.V17_10;

/**
 * 获取项目内便携版 PG 二进制根目录
 *
 * dev 环境：app.getAppPath() 返回项目根目录，便携版位于 <root>/resources/pg/<version>/
 * prod 环境：process.resourcesPath 指向 app.asar 同级 resources，便携版位于 <resources>/pg/<version>/
 *
 * @returns 便携版 PG 根目录（包含 18.4/、17.10/ 子目录）；不存在时返回空串
 */
function getPortablePgRoot(): string {
  const config = getAppConfig();
  if (config.isDev) {
    // dev：app.getAppPath() 返回项目根目录（package.json 所在目录）
    return join(app.getAppPath(), 'resources', 'pg');
  }
  // prod：app.asar 同级 resources 目录由 electron-builder.yml 的 extraResources 注入
  return join(process.resourcesPath, 'pg');
}

/**
 * 获取 PG 二进制路径
 *
 * 优先级：
 * 1. 项目内便携版 resources/pg/<version>/bin/postgres.exe（dev 和 prod 都适用）
 * 2. dev 环境 fallback：系统 PATH 中的 'postgres'（便携版未下载时）
 * 3. prod 环境：便携版必须存在，否则返回路径（让 spawn 报 ENOENT 暴露问题）
 *
 * @param version PG 版本号，默认 18.4
 * @returns postgres 可执行文件路径
 */
export function getPgBinaryPath(version: string = DEFAULT_VERSION): string {
  // 优先用便携版（dev 和 prod 都适用）
  const portablePath = join(getPortablePgRoot(), version, 'bin', 'postgres.exe');
  if (existsSync(portablePath)) {
    return portablePath;
  }

  const config = getAppConfig();
  // dev 环境 fallback：系统 PATH 中的 postgres / initdb
  if (config.isDev) {
    logger.warn(
      { portablePath },
      '便携版 PG 不存在，fallback 到系统 PATH（请运行 pnpm download:pg 下载便携版）',
    );
    return 'postgres';
  }

  // prod 环境：便携版必须存在（不存在也返回路径，让上层 spawn 报 ENOENT 暴露打包问题）
  return portablePath;
}

/**
 * 检测指定版本的便携版 PG 是否已下载
 *
 * 用于 AGE 降级路径：17.10 便携版未下载时跳过降级，仅 warn 不阻塞应用启动
 * （便携版 PG 不含 AGE 扩展二进制，降级到 17.10 同样无法解决 AGE 问题）
 *
 * @param version PG 版本号，默认 18.4
 * @returns true=便携版 postgres.exe 存在；false=未下载
 */
export function isPortablePgAvailable(version: string = DEFAULT_VERSION): boolean {
  const portablePath = join(getPortablePgRoot(), version, 'bin', 'postgres.exe');
  return existsSync(portablePath);
}

/**
 * 获取 PG 数据目录
 *
 * 路径： %APPDATA%/<AppName>/pgdata-<version>/
 * 版本切换时通过目录后缀隔离，避免不同 PG 主版本数据目录混用
 *
 * @param version PG 版本号，默认 18.4
 * @returns 数据目录绝对路径
 */
export function getPgDataDir(version: string = DEFAULT_VERSION): string {
  return join(getUserDataPath(), `pgdata-${version}`);
}

/**
 * 从 PostgreSQL 连接 URL 解析 username
 *
 * 用于 initdb 时设置 superuser 名（保证 PG 启动后能用 url 中的 username 连接）
 * 例：postgresql://nwa@localhost:5433/nwa → 'nwa'
 *     postgresql://localhost:5433/postgres → 'postgres'（兜底）
 *
 * @param url PG 连接 URL（如 config.pg.url）
 * @returns username，URL 无 username 时返回 'postgres'（PG 默认 superuser 名）
 */
function parsePgUsername(url: string): string {
  try {
    const parsed = new URL(url);
    // URL.username 对 'postgresql://nwa@localhost' 返回 'nwa'
    // 对 'postgresql://localhost' 返回 ''（无 username）
    if (parsed.username.length > 0) {
      // URL 编码的 username（如 %2F）需 decodeURIComponent 还原
      return decodeURIComponent(parsed.username);
    }
  } catch (err) {
    logger.warn({ url, error: err }, '解析 PG URL username 失败，使用 postgres 兜底');
  }
  return 'postgres';
}

/**
 * 检测 PG 数据目录是否已初始化
 *
 * initdb 成功后会在数据目录创建 PG_VERSION 文件，作为初始化完成的标志
 *
 * @param version PG 版本号，默认 18.4
 * @returns true=已初始化；false=未初始化
 */
export function isPgInitialized(version: string = DEFAULT_VERSION): boolean {
  const dataDir = getPgDataDir(version);
  const versionFile = join(dataDir, PG_VERSION_FILE);
  return existsSync(versionFile);
}

/**
 * 执行 initdb 初始化数据目录
 *
 * 调用 initdb 命令：
 *   initdb -D <dataDir> --username=postgres --auth=trust --encoding=UTF8
 *
 * - --username=postgres：默认 superuser 名
 * - --auth=trust：本地信任认证（嵌入式无需密码）
 * - --encoding=UTF8：字符集
 *
 * @param version PG 版本号，默认 18.4
 * @throws AppError(ErrorCode.PG_INIT_FAILED) initdb 失败或超时
 */
export async function initdb(version: string = DEFAULT_VERSION): Promise<void> {
  const dataDir = getPgDataDir(version);
  const binaryPath = getPgBinaryPath(version);
  // dev：binaryPath='postgres'，initdb 应在系统 PATH（同目录）
  // prod：binaryPath 指向 postgres.exe，initdb.exe 在同级目录
  const initdbPath = binaryPath === 'postgres' ? 'initdb' : join(binaryPath, '..', 'initdb.exe');

  logger.info({ version, dataDir }, '执行 initdb 初始化数据目录');

  const config = getAppConfig();

  // 从 config.pg.url 解析 username 作为 PG superuser 名
  // initdb 默认创建 username 同名数据库（与 config.pg.url 的 path 一致）
  // 例：postgresql://nwa@localhost:5433/nwa → username=nwa, 默认 DB=nwa
  // 兜底：URL 无 username 时用 'postgres'（PG 默认 superuser 名）
  const pgUser = parsePgUsername(config.pg.url);
  logger.info({ pgUser }, 'initdb 用 superuser 用户名');

  return new Promise<void>((resolve, reject) => {
    // spawn 后赋值给外层 child 变量，便于超时回调 kill
    let child: ReturnType<typeof spawn>;
    // initdb 超时定时器：超时后强制杀进程并 reject
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new AppError(ErrorCode.PG_INIT_FAILED, `initdb 超时（${config.pg.initdbTimeout}ms）`));
    }, config.pg.initdbTimeout).unref();

    child = spawn(
      initdbPath,
      ['-D', dataDir, `--username=${pgUser}`, '--auth=trust', '--encoding=UTF8'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    // 收集 stderr 用于失败时输出错误信息
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      logger.debug({ version }, `initdb stdout: ${chunk.toString().trim()}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      stderr += text;
      logger.warn({ version }, `initdb stderr: ${text}`);
    });

    // 进程退出：根据 exit code 判断成功/失败
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        logger.info({ version, dataDir }, 'initdb 完成');
        resolve();
      } else {
        reject(
          new AppError(
            ErrorCode.PG_INIT_FAILED,
            `initdb 失败（code=${code}, signal=${signal}）: ${stderr}`,
          ),
        );
      }
    });

    // spawn 本身失败（如 initdb 不存在）：触发 error 事件
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new AppError(ErrorCode.PG_INIT_FAILED, `initdb 进程错误: ${err.message}`));
    });
  });
}

/**
 * 确保数据目录已初始化
 *
 * 首次启动时调用：若已初始化则跳过，否则执行 initdb
 *
 * @param version PG 版本号，默认 18.4
 * @throws AppError(ErrorCode.PG_INIT_FAILED) initdb 失败
 */
export async function ensureInstalled(version: string = DEFAULT_VERSION): Promise<void> {
  if (isPgInitialized(version)) {
    logger.debug({ version }, 'PG 数据目录已存在，跳过 initdb');
    return;
  }
  await initdb(version);
}

/**
 * 切换 PG 版本（AGE 降级用，设计文档 §6.5）
 *
 * 流程：
 * 1. 确保目标版本数据目录已初始化（必要时执行 initdb）
 * 2. 调用方负责 stop 旧版本 + start 新版本（由 db-init.ts 编排）
 *
 * @param targetVersion 目标 PG 版本（如 17.10）
 * @throws AppError(ErrorCode.PG_INIT_FAILED) initdb 失败
 */
export async function switchVersion(targetVersion: string): Promise<void> {
  if (targetVersion !== FALLBACK_VERSION) {
    logger.warn({ targetVersion }, '切换到非标准版本，可能不兼容');
  }
  logger.info({ targetVersion }, '切换 PG 版本');
  await ensureInstalled(targetVersion);
}
