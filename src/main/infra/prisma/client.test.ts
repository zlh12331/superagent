// src/main/infra/prisma/client.test.ts
// PrismaClient 单例工厂单元测试
//
// 测试策略：
// 1. vi.mock('@prisma/client') 替换 PrismaClient 构造函数
// 2. 使用 vi.fn(function () { return mockInstance; }) 避免 [[Construct]] 陷阱（Phase 3b 经验）
// 3. 不连接真实 PG，仅验证单例行为与生命周期
// 4. 重置缓存确保测试隔离
//
// Prisma 7 适配说明：
// - Prisma 7 移除了 PrismaClientOptions.datasources 字段
// - 连接 URL 由 prisma.config.ts + env(DATABASE_URL) 提供，运行时通过 adapter 注入
// - 测试不验证 datasources URL，改为验证 log 配置与生命周期

import { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disconnectPrisma,
  getPrismaClient,
  resetPrismaClient,
  testPrismaConnection,
} from './client';

// mockPrismaInstance：模拟 PrismaClient 实例的关键方法
const mockPrismaInstance = {
  $on: vi.fn(),
  $connect: vi.fn().mockResolvedValue(undefined),
  $disconnect: vi.fn().mockResolvedValue(undefined),
};

// config/index.ts 与 logger.ts 都 import { app } from 'electron'，必须 mock 否则 Node 环境下 app 为 undefined
// 使用 vi.hoisted 导出 mock 对象（vi.mock factory 不能直接引用外部 const）
const { mockApp, mockPrismaPg } = vi.hoisted(() => ({
  mockApp: {
    isPackaged: false,
    getPath: vi.fn((name: string) => `/tmp/test-userdata/${name}`),
  },
  // mock PrismaPg adapter 构造函数，避免真实加载 pg 模块
  // biome-ignore lint/complexity/useArrowFunction: 需要 [[Construct]] 调用（client.ts 用 new PrismaPg(...)）
  mockPrismaPg: vi.fn(function () {
    return { adapter: true };
  }),
}));

vi.mock('electron', () => ({ app: mockApp }));
// biome-ignore lint/style/useNamingConvention: 保留 PrismaPg 大写以匹配 @prisma/adapter-pg SDK 导出名
vi.mock('@prisma/adapter-pg', () => ({ PrismaPg: mockPrismaPg }));

// 关键：用 function 表达式实现 constructor（Vitest 4 vi.fn 箭头函数无 [[Construct]]）
vi.mock('@prisma/client', () => ({
  // biome-ignore lint/complexity/useArrowFunction: 需要 [[Construct]] 调用
  // biome-ignore lint/style/useNamingConvention: 保留 PrismaClient 大写以匹配 Prisma SDK 类名
  PrismaClient: vi.fn(function () {
    return mockPrismaInstance;
  }),
}));

describe('PrismaClient 单例工厂', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrismaInstance.$on.mockClear();
    mockPrismaInstance.$connect.mockClear();
    mockPrismaInstance.$disconnect.mockClear();
    mockPrismaInstance.$connect.mockResolvedValue(undefined);
    mockPrismaInstance.$disconnect.mockResolvedValue(undefined);
    resetPrismaClient();
  });

  afterEach(() => {
    resetPrismaClient();
  });

  it('应返回 PrismaClient 实例', () => {
    const client = getPrismaClient();
    expect(client).toBe(mockPrismaInstance);
  });

  it('应使用单例模式（重复调用返回同一实例）', () => {
    const c1 = getPrismaClient();
    const c2 = getPrismaClient();
    expect(c1).toBe(c2);
    // PrismaClient 构造函数只被调用 1 次
    expect(PrismaClient).toHaveBeenCalledTimes(1);
  });

  it('应配置 error 与 warn 事件日志', () => {
    getPrismaClient();

    expect(PrismaClient).toHaveBeenCalledTimes(1);
    const callArgs = (PrismaClient as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[0] as { log?: Array<{ level: string; emit: string }> } | undefined;
    expect(callArgs?.log).toEqual([
      { level: 'error', emit: 'event' },
      { level: 'warn', emit: 'event' },
    ]);
  });

  it('应绑定 error 与 warn 日志事件', () => {
    getPrismaClient();
    expect(mockPrismaInstance.$on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mockPrismaInstance.$on).toHaveBeenCalledWith('warn', expect.any(Function));
  });

  it('disconnectPrisma 应调用 $disconnect 并清空缓存', async () => {
    getPrismaClient();
    await disconnectPrisma();

    expect(mockPrismaInstance.$disconnect).toHaveBeenCalledTimes(1);

    // 缓存清空后，再次调用应重新实例化
    getPrismaClient();
    expect(PrismaClient).toHaveBeenCalledTimes(2);
  });

  it('disconnectPrisma 在 client 未初始化时应安全返回', async () => {
    await expect(disconnectPrisma()).resolves.toBeUndefined();
    expect(mockPrismaInstance.$disconnect).not.toHaveBeenCalled();
  });

  it('resetPrismaClient 应清空缓存', () => {
    getPrismaClient();
    resetPrismaClient();
    getPrismaClient();

    // 缓存清空后重新实例化，构造函数被调用 2 次
    expect(PrismaClient).toHaveBeenCalledTimes(2);
  });

  it('testPrismaConnection 应调用 $connect 并返回 true', async () => {
    const result = await testPrismaConnection();
    expect(result).toBe(true);
    expect(mockPrismaInstance.$connect).toHaveBeenCalledTimes(1);
  });
});
