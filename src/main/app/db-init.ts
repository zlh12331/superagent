// src/main/app/db-init.ts
// 数据库初始化编排（设计文档 §1.1 + §6.5 AGE 兼容性策略）
//
// 职责：
// 1. 编排 PG 启动 + DB 初始化流程
// 2. AGE 加载失败时降级 PG 版本
// 3. 串联 pg-installer / pg-controller / Prisma migrate / AGE / HNSW
//
// 启动顺序：
//   ensureInstalled(18.4) → pgController.start → testPrismaConnection
//   → prisma migrate deploy → ensureAgeExtension
//   → 失败则 switchVersion(17.10) + 重启 PG + 重新 AGE
//   → ensureHnswIndex
//
// 注意：本模块由 index.ts 在 app.whenReady() 中调用

import { POSTGRES_VERSIONS } from '@novel-writer/shared';
import { getAppConfig } from '../config';
import { PgController } from '../infra/pg/pg-controller';
import {
  ensureInstalled,
  getPgBinaryPath,
  getPgDataDir,
  switchVersion,
} from '../infra/pg/pg-installer';
import { disconnectPrisma, getPrismaClient, testPrismaConnection } from '../infra/prisma/client';
import { ensureAgeExtension } from '../infra/prisma/extensions/age';
import { ensureHnswIndex } from '../infra/prisma/extensions/hnsw';
import { logger } from '../utils/logger';

/** PG 控制器单例（模块级，供 getPgController 测试访问器读取） */
let pgController: PgController | null = null;

/**
 * 创建 PgController 实例
 *
 * 根据当前配置生成 binaryPath 与 dataDir，构造 PgController
 *
 * @param version PG 版本号（用于解析 binaryPath 与 dataDir）
 * @returns PgController 实例
 */
function createPgController(version: string): PgController {
  const config = getAppConfig();
  return new PgController({
    binaryPath: getPgBinaryPath(version),
    dataDir: getPgDataDir(version),
    port: config.pg.port,
  });
}

/**
 * 初始化数据库
 *
 * 完整流程：
 * 1. 确保数据目录已初始化（initdb）
 * 2. 启动 PG 子进程
 * 3. 测试 PrismaClient 连接
 * 4. 执行 Prisma migration（deploy 模式）
 * 5. 加载 AGE 扩展（失败降级到 PG 17.10）
 * 6. 初始化 HNSW 索引
 *
 * @throws AppError 任何阶段失败
 */
export async function initializeDatabase(): Promise<void> {
  const defaultVersion = POSTGRES_VERSIONS.V18_4;
  logger.info({ version: defaultVersion }, '初始化数据库');

  // 1. initdb（首次启动初始化数据目录）
  await ensureInstalled(defaultVersion);

  // 2. 启动 PG 子进程
  pgController = createPgController(defaultVersion);
  await pgController.start();

  // 3. 测试 PrismaClient 连接（带 retry）
  await testPrismaConnection();
  logger.info({}, '数据库连接成功');

  // 4. 执行 migration（通过 Prisma CLI）
  // 注：Prisma 7 推荐用 prisma migrate deploy 在生产环境执行
  // 这里通过 child_process 调用，因为 Prisma client 不直接暴露 migrate API
  await runMigrateDeploy();

  // 5. 加载 AGE 扩展（失败则降级到 PG 17.10）
  const client = getPrismaClient();
  const ageOk = await ensureAgeExtension(client);
  if (!ageOk) {
    logger.warn({}, 'AGE 在 PG 18.4 上加载失败，触发降级流程');
    await downgradeForAge();
  }

  // 6. 初始化 HNSW 索引（pg_trgm + HNSW + 复合索引）
  await ensureHnswIndex(client);

  logger.info({}, '数据库初始化完成');
}

/**
 * AGE 降级流程（设计文档 §6.5）
 *
 * 1. 停止当前 PG（18.4）
 * 2. 断开 PrismaClient（避免连接旧 PG）
 * 3. 切换到 PG 17.10（确保数据目录已初始化）
 * 4. 重启 PG（17.10）
 * 5. 重新加载 AGE 扩展
 *
 * @throws Error AGE 在 17.10 上仍无法加载
 */
async function downgradeForAge(): Promise<void> {
  if (pgController === null) {
    throw new Error('PG 控制器未初始化');
  }

  // 1. 停止当前 PG（18.4）
  await pgController.stop();
  // 2. 断开 PrismaClient（连接池中可能持有旧 PG 的连接）
  await disconnectPrisma();

  // 3. 切换到 PG 17.10（确保 17.10 数据目录已 initdb）
  const fallbackVersion = POSTGRES_VERSIONS.V17_10;
  await switchVersion(fallbackVersion);

  // 4. 重启 PG（17.10）
  pgController = createPgController(fallbackVersion);
  await pgController.start();
  // 重新测试连接（新 PG 实例）
  await testPrismaConnection();

  // 5. 重新加载 AGE 扩展
  const client = getPrismaClient();
  const ageOk = await ensureAgeExtension(client);
  if (!ageOk) {
    logger.error({}, 'AGE 在 PG 17.10 上仍无法加载，扩展可能不兼容');
    throw new Error('Apache AGE 扩展加载失败');
  }
  logger.info({ version: fallbackVersion }, 'AGE 降级完成');
}

/**
 * 执行 prisma migrate deploy
 *
 * 通过 child_process 调用 prisma CLI（Prisma 7 不在 client 中暴露 migrate API）
 * 使用 spawn 而非 exec，便于流式收集 stdout/stderr
 *
 * @throws Error prisma migrate 失败或进程错误
 */
async function runMigrateDeploy(): Promise<void> {
  // 动态 import：按需加载 child_process，便于测试 vi.mock 拦截
  const { spawn } = await import('node:child_process');
  logger.info({}, '执行 prisma migrate deploy');

  return new Promise<void>((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
    });

    // 收集 stderr 用于失败时输出错误信息
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      logger.debug({}, `prisma migrate: ${chunk.toString().trim()}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      stderr += text;
      logger.warn({}, `prisma migrate stderr: ${text}`);
    });

    // 进程退出：根据 exit code 判断成功/失败
    child.on('exit', (code) => {
      if (code === 0) {
        logger.info({}, 'prisma migrate deploy 完成');
        resolve();
      } else {
        reject(new Error(`prisma migrate deploy 失败（code=${code}）: ${stderr}`));
      }
    });

    // spawn 本身失败（如 pnpm 不存在）：触发 error 事件
    child.on('error', (err) => {
      reject(new Error(`prisma migrate deploy 进程错误: ${err.message}`));
    });
  });
}

/**
 * 关闭数据库
 *
 * 应用退出时调用（main/index.ts before-quit）：
 * 1. 断开 PrismaClient（释放连接池）
 * 2. 停止 PG 子进程（SIGTERM → 5s → SIGKILL）
 */
export async function shutdownDatabase(): Promise<void> {
  await disconnectPrisma();
  if (pgController !== null) {
    await pgController.stop();
    pgController = null;
  }
}

/**
 * 获取 PG 控制器实例
 *
 * 仅用于测试与状态查询，业务代码不应依赖此函数
 *
 * @returns PgController 实例（未初始化时为 null）
 */
export function getPgController(): PgController | null {
  return pgController;
}
