// src/main/app/db-init.ts
// 数据库初始化编排（设计文档 §1.1 + §6.5 AGE 兼容性策略）
//
// 职责：
// 1. 编排 PG 启动 + DB 初始化流程
// 2. 串联 pg-installer / pg-supervisor / Prisma migrate / AGE / HNSW
//
// 启动顺序：
//   ensureInstalled(17.2-mingw) → pgSupervisor.start → testPrismaConnection
//   → prisma migrate deploy → ensureAgeExtension → ensureHnswIndex
//
// 说明：
// - ShanGor 预编译包自带 AGE 1.5.0 + pgvector 0.8.0，无需降级
// - AGE / HNSW 加载失败时仅 warn，不阻塞应用启动（核心功能不依赖扩展）
// - 旧版 AGE 降级路径已移除（V17_10 常量保留仅为历史数据目录检测）
// - PgSupervisor 包装 PgController，提供崩溃自动重启（指数退避 5s/10s/30s）
//
// 注意：本模块由 index.ts 在 app.whenReady() 中调用

import { POSTGRES_VERSIONS } from '@novel-writer/shared';
import { getAppConfig } from '../config';
import { PgController } from '../infra/pg/pg-controller';
import { ensureInstalled, getPgBinaryPath, getPgDataDir } from '../infra/pg/pg-installer';
import { PgSupervisor } from '../infra/pg/pg-supervisor';
import { disconnectPrisma, getPrismaClient, testPrismaConnection } from '../infra/prisma/client';
import { ensureAgeExtension } from '../infra/prisma/extensions/age';
import { ensureHnswIndex } from '../infra/prisma/extensions/hnsw';
import { logger } from '../utils/logger';

/** PG Supervisor 单例（模块级，提供崩溃自愈 + 状态变更事件） */
let pgSupervisor: PgSupervisor | null = null;

/**
 * 创建 PgSupervisor 实例
 *
 * 根据当前配置生成 binaryPath 与 dataDir，构造 PgController 后包装为 PgSupervisor
 *
 * @param version PG 版本号（用于解析 binaryPath 与 dataDir）
 * @returns PgSupervisor 实例
 */
function createPgSupervisor(version: string): PgSupervisor {
  const config = getAppConfig();
  const pgConfig = {
    binaryPath: getPgBinaryPath(version),
    dataDir: getPgDataDir(version),
    port: config.pg.port,
  };
  // PgSupervisor 包装 PgController，提供崩溃自动重启（指数退避）
  return new PgSupervisor(new PgController(pgConfig));
}

/**
 * 初始化数据库
 *
 * 完整流程：
 * 1. 确保数据目录已初始化（initdb）
 * 2. 启动 PG 子进程
 * 3. 测试 PrismaClient 连接
 * 4. 执行 Prisma migration（deploy 模式）
 * 5. 加载 AGE 扩展（Cypher 图查询功能）
 * 6. 初始化 HNSW 向量索引 + 全文索引
 *
 * 容错策略：
 * - AGE 加载失败 → 仅 warn 不阻塞（人物关系图功能不可用，其他功能正常）
 * - HNSW 索引创建失败 → 仅 warn 不阻塞（RAG 检索不可用）
 * - 核心功能（项目/章节/角色 CRUD）不依赖 AGE / pgvector
 *
 * @throws AppError 任何阶段失败（initdb / PG 启动 / migrate）
 */
export async function initializeDatabase(): Promise<void> {
  const defaultVersion = POSTGRES_VERSIONS.V17_2_MINGW;
  logger.info({ version: defaultVersion }, '初始化数据库');

  // 1. initdb（首次启动初始化数据目录）
  await ensureInstalled(defaultVersion);

  // 2. 启动 PG 子进程（PgSupervisor 提供崩溃自愈，PG 异常退出时自动重启）
  pgSupervisor = createPgSupervisor(defaultVersion);
  await pgSupervisor.start();

  // 3. 测试 PrismaClient 连接（带 retry）
  await testPrismaConnection();
  logger.info({}, '数据库连接成功');

  // 4. 执行 migration（通过 Prisma CLI）
  // 注：Prisma 7 推荐用 prisma migrate deploy 在生产环境执行
  // 这里通过 child_process 调用，因为 Prisma client 不直接暴露 migrate API
  await runMigrateDeploy();

  // 5. 加载 AGE 扩展（失败仅 warn 不阻塞，人物关系图功能不可用）
  const client = getPrismaClient();
  const ageOk = await ensureAgeExtension(client);
  if (!ageOk) {
    logger.warn({}, 'AGE 扩展加载失败，人物关系图（Cypher）功能不可用，其他功能正常');
  }

  // 6. 初始化 HNSW 索引（pgvector + pg_trgm + 复合索引）
  await ensureHnswIndex(client);

  logger.info({}, '数据库初始化完成');
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
    // shell: true 让 Windows 通过 PATHEXT 解析 pnpm.cmd（Electron 主进程默认 PATH 不含 .cmd 扩展）
    // 在 dev 环境 pnpm 通常位于 nodejs 目录或 Node 安装目录的 .cmd shim 中
    const child = spawn('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
      shell: true,
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
 * 2. 停止 PG 子进程（PgSupervisor.stop 取消重启等待 + SIGTERM → 5s → SIGKILL）
 */
export async function shutdownDatabase(): Promise<void> {
  await disconnectPrisma();
  if (pgSupervisor !== null) {
    await pgSupervisor.stop();
    pgSupervisor = null;
  }
}

/**
 * 获取 PG 控制器实例
 *
 * 仅用于测试与状态查询，业务代码不应依赖此函数
 * 返回 PgSupervisor 实例（对外接口与 PgController 兼容，并增加 'restarting'/'dead' 状态）
 *
 * @returns PgSupervisor 实例（未初始化时为 null）
 */
export function getPgController(): PgSupervisor | null {
  return pgSupervisor;
}
