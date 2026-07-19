// src/main/app/db-init.test.ts
// 数据库初始化编排单元测试
//
// 测试策略：
// 1. vi.mock 所有 infra 模块（pg-installer / pg-controller / prisma/client / age / hnsw）
// 2. vi.mock('node:child_process') 拦截 runMigrateDeploy 中的 spawn
// 3. vi.mock('electron') 提供 app.isPackaged / app.getPath（config 与 logger 依赖）
// 4. 使用 vi.hoisted 声明 mock 对象（配合静态 import 避免 TDZ，参考 pg-installer.test.ts）
// 5. 不实际启动 PG，仅验证调用顺序与降级流程

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted：将 mock 对象声明提升到文件顶部，确保 vi.mock 工厂执行时能访问
// （vi.mock 会被 hoist 到 import 之前，工厂内直接引用外部 const 会触发 TDZ）
const {
  mockEnsureInstalled,
  mockSwitchVersion,
  mockGetPgBinaryPath,
  mockGetPgDataDir,
  mockPgController,
  mockTestPrismaConnection,
  mockDisconnectPrisma,
  mockGetPrismaClient,
  mockEnsureAgeExtension,
  mockEnsureHnswIndex,
  mockSpawn,
  mockApp,
} = vi.hoisted(() => ({
  // pg-installer mock
  mockEnsureInstalled: vi.fn().mockResolvedValue(undefined),
  mockSwitchVersion: vi.fn().mockResolvedValue(undefined),
  mockGetPgBinaryPath: vi.fn().mockReturnValue('postgres'),
  mockGetPgDataDir: vi.fn().mockReturnValue('/tmp/pgdata'),
  // PgController 实例 mock（new PgController(...) 返回此对象）
  mockPgController: {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  },
  // prisma/client mock
  mockTestPrismaConnection: vi.fn().mockResolvedValue(true),
  mockDisconnectPrisma: vi.fn().mockResolvedValue(undefined),
  mockGetPrismaClient: vi.fn().mockReturnValue({}),
  // age / hnsw mock
  mockEnsureAgeExtension: vi.fn().mockResolvedValue(true),
  mockEnsureHnswIndex: vi.fn().mockResolvedValue(undefined),
  // child_process.spawn mock：返回支持 stdout/stderr/on/kill/pid 的模拟 child
  // 关键：setTimeout 异步触发 exit(0)，让 runMigrateDeploy 的 Promise 能 resolve
  // 否则 Promise 永不 settle，initializeDatabase 会挂起
  // biome-ignore lint/complexity/useArrowFunction: vi.fn 内部使用 function 表达式
  mockSpawn: vi.fn(function () {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const child = {
      stdout: {
        on: (_e: string, cb: (...args: unknown[]) => void) => {
          handlers.stdout = cb;
        },
      },
      stderr: {
        on: (_e: string, cb: (...args: unknown[]) => void) => {
          handlers.stderr = cb;
        },
      },
      on: (event: string, cb: (...args: unknown[]) => void) => {
        handlers[event] = cb;
      },
      kill: vi.fn(),
      pid: 99999,
    };
    // 异步触发 exit(0)，确保 runMigrateDeploy 完成
    // setTimeout 0 让 on('exit', ...) 回调先注册再触发
    setTimeout(() => handlers.exit?.(0), 0);
    return child;
  }),
  // electron app mock（config 与 logger 模块依赖）
  mockApp: {
    isPackaged: false,
    getPath: vi.fn((name: string) => `/tmp/test-userdata/${name}`),
  },
}));

// 注册所有 mock（vi.mock 会被 hoist 到文件顶部）
vi.mock('electron', () => ({ app: mockApp }));

vi.mock('../infra/pg/pg-installer', () => ({
  ensureInstalled: mockEnsureInstalled,
  switchVersion: mockSwitchVersion,
  getPgBinaryPath: mockGetPgBinaryPath,
  getPgDataDir: mockGetPgDataDir,
}));

vi.mock('../infra/pg/pg-controller', () => ({
  // PgController 是 class，必须用 function 表达式实现 constructor（[[Construct]]）
  // biome-ignore lint/complexity/useArrowFunction: 需要 [[Construct]] 调用
  // biome-ignore lint/style/useNamingConvention: 保留 PgController 大写以匹配 class 名
  PgController: vi.fn(function () {
    return mockPgController;
  }),
}));

vi.mock('../infra/prisma/client', () => ({
  testPrismaConnection: mockTestPrismaConnection,
  disconnectPrisma: mockDisconnectPrisma,
  getPrismaClient: mockGetPrismaClient,
}));

vi.mock('../infra/prisma/extensions/age', () => ({
  ensureAgeExtension: mockEnsureAgeExtension,
}));

vi.mock('../infra/prisma/extensions/hnsw', () => ({
  ensureHnswIndex: mockEnsureHnswIndex,
}));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

// 静态导入被测模块：vi.mock 已 hoist 到文件顶部，mock 此时已生效
import { getPgController, initializeDatabase, shutdownDatabase } from './db-init';

describe('数据库初始化编排', () => {
  beforeEach(() => {
    // mockReset 而非 clearAllMocks，确保完全隔离（计划注意事项 #6）
    // 但保留 mockResolvedValue 默认实现（通过重新设置）
    vi.clearAllMocks();
    mockEnsureInstalled.mockResolvedValue(undefined);
    mockSwitchVersion.mockResolvedValue(undefined);
    mockGetPgBinaryPath.mockReturnValue('postgres');
    mockGetPgDataDir.mockReturnValue('/tmp/pgdata');
    mockPgController.start.mockResolvedValue(undefined);
    mockPgController.stop.mockResolvedValue(undefined);
    mockTestPrismaConnection.mockResolvedValue(true);
    mockEnsureAgeExtension.mockResolvedValue(true);
    mockEnsureHnswIndex.mockResolvedValue(undefined);
    mockDisconnectPrisma.mockResolvedValue(undefined);
    mockGetPrismaClient.mockReturnValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initializeDatabase', () => {
    it('成功流程应按顺序调用所有步骤', async () => {
      await initializeDatabase();

      // 1. initdb（默认版本 18.4）
      expect(mockEnsureInstalled).toHaveBeenCalledWith('18.4');
      // 2. pgController.start（启动 PG 子进程）
      expect(mockPgController.start).toHaveBeenCalledTimes(1);
      // 3. testPrismaConnection（连接测试）
      expect(mockTestPrismaConnection).toHaveBeenCalledTimes(1);
      // 4. AGE 扩展加载
      expect(mockEnsureAgeExtension).toHaveBeenCalledTimes(1);
      // 5. HNSW 索引初始化
      expect(mockEnsureHnswIndex).toHaveBeenCalledTimes(1);
      // spawn 调用 prisma migrate deploy
      expect(mockSpawn).toHaveBeenCalled();
    });

    it('initdb 失败应抛错并停止流程', async () => {
      mockEnsureInstalled.mockRejectedValueOnce(new Error('initdb failed'));
      await expect(initializeDatabase()).rejects.toThrow('initdb failed');
      // initdb 失败后不应启动 PG
      expect(mockPgController.start).not.toHaveBeenCalled();
    });

    it('PG 启动失败应抛错', async () => {
      mockPgController.start.mockRejectedValueOnce(new Error('PG start failed'));
      await expect(initializeDatabase()).rejects.toThrow('PG start failed');
    });

    it('AGE 在 18.4 失败应触发降级流程', async () => {
      // 第一次（18.4）失败，第二次（17.10）成功
      mockEnsureAgeExtension.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      await initializeDatabase();

      // 应停止旧 PG + 切换版本 + 启动新 PG + 重新 AGE
      expect(mockPgController.stop).toHaveBeenCalledTimes(1);
      expect(mockSwitchVersion).toHaveBeenCalledWith('17.10');
      expect(mockPgController.start).toHaveBeenCalledTimes(2);
      expect(mockEnsureAgeExtension).toHaveBeenCalledTimes(2);
    });

    it('AGE 降级后仍失败应抛错', async () => {
      // 两次 AGE 都失败
      mockEnsureAgeExtension.mockResolvedValue(false);
      await expect(initializeDatabase()).rejects.toThrow('Apache AGE');
    });
  });

  describe('shutdownDatabase', () => {
    it('应断开 PrismaClient 并停止 PG', async () => {
      await initializeDatabase();
      await shutdownDatabase();

      // 成功路径下 initializeDatabase 不调用 disconnectPrisma
      // shutdownDatabase 调用 1 次 disconnectPrisma
      expect(mockDisconnectPrisma).toHaveBeenCalledTimes(1);
      expect(mockPgController.stop).toHaveBeenCalledTimes(1);
    });

    it('未初始化时应安全返回', async () => {
      // 未调用 initializeDatabase 直接 shutdown，不应抛错
      await expect(shutdownDatabase()).resolves.toBeUndefined();
      // pgController 为 null 时不应调用 stop
      expect(mockPgController.stop).not.toHaveBeenCalled();
    });
  });

  describe('getPgController', () => {
    it('未初始化时应返回 null', () => {
      expect(getPgController()).toBeNull();
    });

    it('初始化后应返回 controller 实例', async () => {
      await initializeDatabase();
      // mockPgController 是 new PgController(...) 的返回值
      expect(getPgController()).toBe(mockPgController);
      await shutdownDatabase();
    });
  });
});
