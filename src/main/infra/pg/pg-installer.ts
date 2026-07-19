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
 * 获取 PG 二进制路径
 *
 * dev 环境：返回 'postgres'（依赖系统 PATH 中的 postgres 可执行文件）
 * prod 环境：返回 resources/pg/<version>/bin/postgres.exe（便携版二进制）
 *
 * @param version PG 版本号，默认 18.4
 * @returns postgres 可执行文件路径
 */
export function getPgBinaryPath(version: string = DEFAULT_VERSION): string {
  const config = getAppConfig();
  if (config.isDev) {
    // dev 环境：依赖系统 PATH 中的 postgres / initdb
    return 'postgres';
  }
  // 生产环境：从打包资源目录加载便携版 PG 二进制
  // process.resourcesPath 由 Electron 注入，指向 app.asar 同级 resources 目录
  return join(process.resourcesPath, 'pg', version, 'bin', 'postgres.exe');
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
      ['-D', dataDir, '--username=postgres', '--auth=trust', '--encoding=UTF8'],
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
