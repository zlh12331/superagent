// tests/integration/helpers/pg-container.ts
// 集成测试 PG 容器管理（Testcontainers + pgvector/pgvector:pg17）
// 设计文档 §8.3 集成测试策略 / Phase 9 plan Task 3
//
// 职责：
// 1. startTestContainer：启动 pgvector/pgvector:pg17 容器（仅在 vitest globalSetup 调用一次）
//    - 容器启动后执行 prisma migration.sql（移除 age 扩展创建）
//    - 创建 HNSW 索引（复用 src/main/infra/prisma/extensions/hnsw.ts）
//    - 设置 process.env.DATABASE_URL 供 worker 进程复用
// 2. stopTestContainer：关闭容器（仅在 globalSetup 返回函数中调用）
// 3. getTestPrismaClient：返回 worker 进程的 PrismaClient 单例（幂等，连接到 DATABASE_URL）
// 4. isContainerReady：检查容器是否就绪（DATABASE_URL 已设置）
//
// 设计要点：
// - vitest 4 globalSetup 在主进程执行，worker 进程通过 process.env.DATABASE_URL 复用容器
// - 全局共享 1 个容器（避免每个 worker 启动独立容器）
// - Docker 不可用时 startTestContainer 抛错，globalSetup 捕获并设置 INTEGRATION_SKIP=1
// - 测试文件通过 isContainerReady() 判断，false 时 describe.skip 跳过
//
// 注意：
// - AGE 扩展不在此容器验证（plan §1 范围限定）
// - migration.sql 中 CREATE EXTENSION "age" 语句会在容器内失败，本模块预处理时移除
// - HNSW 索引创建需要 pgvector 扩展已加载，pgvector/pgvector 镜像默认已安装

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { resetPrismaClient } from '../../../src/main/infra/prisma/client';
import {
  ensureHnswIndex,
  resetHnswIndexState,
} from '../../../src/main/infra/prisma/extensions/hnsw';

/** pgvector 官方镜像（基于 PG 17，预装 pgvector 扩展） */
const PGVECTOR_IMAGE = 'pgvector/pgvector:pg17';

/** 容器内数据库名（Testcontainers 默认 test） */
const DB_NAME = 'test';
/** 容器内数据库用户（Testcontainers 默认 test） */
const DB_USER = 'test';
/** 容器内数据库密码（Testcontainers 默认 test） */
const DB_PASSWORD = 'test';

/** migration.sql 文件路径（相对 process.cwd()，由 vitest 运行根决定） */
const MIGRATION_SQL_PATH = join(process.cwd(), 'prisma', 'migrations', '0_init', 'migration.sql');

/** 已启动的容器实例（仅在 globalSetup 进程中持有，worker 进程为 null） */
let startedContainer: StartedPostgreSqlContainer | null = null;

/**
 * worker 进程的 PrismaClient 单例
 *
 * - globalSetup 进程：null（不创建 client，只启动容器）
 * - worker 进程：首次调用 getTestPrismaClient 时创建，连接 process.env.DATABASE_URL
 */
let workerPrismaClient: PrismaClient | null = null;

/**
 * 启动 PG 容器 + 执行 migration + 创建 HNSW 索引
 *
 * 仅在 vitest globalSetup 中调用一次，启动后设置 process.env.DATABASE_URL
 * worker 进程通过 getTestPrismaClient() 复用容器（连接到同一 DATABASE_URL）
 *
 * @throws Error Docker 不可用 / 容器启动失败 / migration 执行失败
 */
export async function startTestContainer(): Promise<void> {
  if (startedContainer !== null) {
    return;
  }

  console.info('[integration] 启动 pgvector/pgvector:pg17 容器（首次启动可能耗时 10-30s）');

  // 1. 启动容器（指定镜像 + 数据库 + 用户 + 密码）
  // 注意：@testcontainers/postgresql v11 类名为 PostgreSqlContainer（小写 q）
  startedContainer = await new PostgreSqlContainer(PGVECTOR_IMAGE)
    .withDatabase(DB_NAME)
    .withUsername(DB_USER)
    .withPassword(DB_PASSWORD)
    .start();

  // 2. 获取连接 URL 并设置环境变量（worker 进程通过此变量连接到容器）
  // 注意：prisma.config.ts 从 env('DATABASE_URL') 读取
  // v11 方法名为 getConnectionUri()（非 getConnectionString()）
  const connectionString = startedContainer.getConnectionUri();
  process.env.DATABASE_URL = connectionString;
  console.info(`[integration] 容器已就绪，连接 URL：${connectionString}`);

  // 3. 创建临时 PrismaClient 执行 migration + HNSW（之后丢弃，由 worker 进程重新创建）
  const prisma = new PrismaClient({
    log: [{ level: 'error', emit: 'event' }],
  });
  await prisma.$connect();

  try {
    // 4. 执行 migration.sql（移除 age 扩展创建，pgvector 镜像不预装 age）
    await runMigrationSql(prisma);

    // 5. 创建 HNSW 索引（重置状态确保每次都执行）
    resetHnswIndexState();
    await ensureHnswIndex(prisma);
    console.info('[integration] HNSW 索引 + trgm 索引已就绪');
  } finally {
    // 6. 关闭临时 client（worker 进程会创建自己的 client）
    await prisma.$disconnect();
  }
}

/**
 * 关闭测试容器
 *
 * 仅在 vitest globalSetup 返回函数中调用（所有测试完成后执行）
 */
export async function stopTestContainer(): Promise<void> {
  if (workerPrismaClient !== null) {
    await workerPrismaClient.$disconnect();
    workerPrismaClient = null;
  }
  if (startedContainer !== null) {
    await startedContainer.stop();
    console.info('[integration] 容器已关闭');
    startedContainer = null;
  }
  // 清理环境变量，避免污染后续 unit 测试
  delete process.env.DATABASE_URL;
}

/**
 * 获取 worker 进程的 PrismaClient 单例（幂等）
 *
 * worker 进程首次调用时创建 PrismaClient，连接到 process.env.DATABASE_URL
 * 后续调用返回缓存的单例
 *
 * @returns 已连接的 PrismaClient
 * @throws Error 容器未启动（process.env.DATABASE_URL 未设置）
 */
export function getTestPrismaClient(): PrismaClient {
  if (workerPrismaClient !== null) {
    return workerPrismaClient;
  }

  if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === '') {
    throw new Error('测试容器未启动，请确认 globalSetup 已执行 startTestContainer');
  }

  console.info('[integration] 创建 worker PrismaClient 单例');
  const prisma = new PrismaClient({
    log: [{ level: 'error', emit: 'event' }],
  });
  workerPrismaClient = prisma;

  // 重置主进程 PrismaClient 单例缓存，让 service 层调用 getPrismaClient() 时
  // 重新创建实例（使用 prisma.config.ts 的 DATABASE_URL，已指向测试容器）
  resetPrismaClient();

  return prisma;
}

/**
 * 检查容器是否就绪（DATABASE_URL 已设置）
 *
 * 测试文件用此函数判断是否跳过测试（Docker 不可用时 globalSetup 不设置 DATABASE_URL）
 *
 * @returns true=容器就绪可运行测试，false=Docker 不可用应跳过
 */
export function isContainerReady(): boolean {
  return process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL !== '';
}

/**
 * 执行 prisma migration.sql 建表
 *
 * 处理逻辑：
 * 1. 读取 migration.sql 文件内容
 * 2. 移除 CREATE EXTENSION "age"（容器内无 age 扩展，集成测试不验证 AGE）
 * 3. 移除 SQL 注释（单行 -- 与多行块注释）
 * 4. 按 `;` 分割为多条 SQL 语句
 * 5. 逐条用 $executeRawUnsafe 执行
 *
 * 注意：不支持 dollar-quoted strings（$$...$$），migration.sql 中未使用
 *
 * @throws Error migration.sql 读取失败 / SQL 执行失败
 */
async function runMigrationSql(prisma: PrismaClient): Promise<void> {
  console.info('[integration] 执行 migration.sql 建表');

  // 1. 读取 migration.sql 文件
  const rawSql = await readFile(MIGRATION_SQL_PATH, 'utf8');

  // 2. 移除 CREATE EXTENSION "age"（pgvector/pgvector 镜像不预装 age）
  //    保留 CREATE EXTENSION "pgvector"（镜像已预装，幂等）
  const sqlWithoutAge = rawSql.replace(/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+"age"\s*;/gi, '');

  // 3. 移除单行注释（-- ...）和多行注释（/* ... */）
  const sqlNoComments = sqlWithoutAge.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  // 4. 按 `;` 分割为多条 SQL 语句，过滤空语句
  // 注意：migration.sql 中没有单引号字符串内的 `;`，可以安全按 `;` 分割
  const statements = sqlNoComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.info(`[integration] migration.sql 解析为 ${statements.length} 条 SQL 语句`);

  // 5. 逐条执行
  for (const stmt of statements) {
    await prisma.$executeRawUnsafe(stmt);
  }

  console.info('[integration] migration.sql 执行完成');
}
