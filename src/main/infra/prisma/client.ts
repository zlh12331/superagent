// src/main/infra/prisma/client.ts
// PrismaClient 单例工厂
// 设计文档 §4.3 infra 层职责：prisma/client = PrismaClient 单例
//
// 职责：
// 1. 单例模式（避免重复实例化，复用连接池）
// 2. 集成 logger（记录查询错误）
// 3. 集成 retry（指数退避，应对瞬时连接失败）
// 4. 提供 disconnect() 用于应用退出时清理
// 5. 提供 resetClient() 用于测试隔离
//
// 注意（Prisma 7 适配）：
// - Prisma 7 起 engine type = "client"，必须通过 Driver Adapter 注入连接
// - adapter 来自 @prisma/adapter-pg，底层用 pg 包建立连接池
// - 连接 URL 由 config.pg.url 提供（默认 postgresql://nwa@localhost:5433/nwa）
// - getPrismaClient() 仅返回单例，不主动 $connect()
// - 调用方应在使用前调用 $connect()（或由 service 层 retry 包裹）

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { getAppConfig } from '../../config';
import { logger } from '../../utils/logger';
import { retry } from '../../utils/retry';

/** 缓存的 PrismaClient 单例（避免重复实例化，复用连接池） */
let cachedClient: PrismaClient | null = null;

/**
 * 获取 PrismaClient 单例
 *
 * 首次调用时实例化：
 * 1. 从 config 读取 PG 连接 URL
 * 2. 用 PrismaPg adapter 包装连接（Prisma 7 engine type="client" 要求）
 * 3. 绑定 error/warn 日志事件
 * 后续调用返回缓存
 *
 * @returns PrismaClient 单例
 */
export function getPrismaClient(): PrismaClient {
  if (cachedClient !== null) {
    return cachedClient;
  }

  const config = getAppConfig();
  // Prisma 7 Driver Adapter：用 pg 连接池包装，让 Prisma 7 在 engine type="client" 下运行
  // adapter 接管底层连接管理，PrismaClient 不再需要 datasources 配置
  const adapter = new PrismaPg({ connectionString: config.pg.url });
  logger.info({ url: config.pg.url }, '初始化 PrismaClient（Prisma 7 + PrismaPg adapter）');

  const client = new PrismaClient({
    // adapter 是 Prisma 7 必填项（engine type="client" 模式下）
    adapter,
    // 日志级别：监听 error 与 warn 事件，由 logger 统一处理
    // 查询日志（query）默认不开启，避免噪声；dev 环境可由 logger.level 控制
    log: [
      { level: 'error', emit: 'event' },
      { level: 'warn', emit: 'event' },
    ],
  });

  // 绑定日志事件（Prisma 7 事件 API）
  client.$on('error', (e) => {
    logger.error({ error: e.message }, 'Prisma 查询错误');
  });
  client.$on('warn', (e) => {
    logger.warn({ message: e.message }, 'Prisma 警告');
  });

  cachedClient = client;
  return client;
}

/**
 * 测试数据库连接（带 retry）
 *
 * Phase 4b 启动 PG 后调用此方法验证连接
 *
 * @returns 成功返回 true，失败抛错
 */
export async function testPrismaConnection(): Promise<boolean> {
  const client = getPrismaClient();
  await retry(async () => {
    await client.$connect();
  });
  return true;
}

/**
 * 断开 PrismaClient 连接
 *
 * 应用退出时调用（main/index.ts before-quit）
 */
export async function disconnectPrisma(): Promise<void> {
  if (cachedClient === null) {
    return;
  }
  try {
    await cachedClient.$disconnect();
    logger.info({}, 'PrismaClient 已断开连接');
  } catch (err) {
    logger.error({ error: err }, 'PrismaClient 断开连接失败');
  } finally {
    cachedClient = null;
  }
}

/**
 * 重置 client 缓存（仅测试用）
 *
 * 测试用例隔离时使用，避免单例污染
 */
export function resetPrismaClient(): void {
  cachedClient = null;
}
