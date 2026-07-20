// src/main/app/service-container.test.ts
// ServiceContainer 单元测试
//
// 测试策略：
// 1. vi.mock 所有依赖模块（stream-bridge / openai-client / embedding-client / prisma/client / db-init / status-broadcaster）
// 2. 使用 vi.hoisted 声明 mock 函数数组，捕获调用顺序
// 3. disposeServices 测试：
//    - 验证按反向依赖顺序调用（StreamBridge.abortAll → resetOpenAIClient → resetEmbeddingClient
//      → disconnectPrisma → shutdownDatabase）
//    - 验证某一阶段抛错时仍继续后续清理（容错）
// 4. resetServices 测试：
//    - 验证 6 个 reset 函数均被调用
//
// 关键点：
// - disposeServices 内部 try-catch 包裹每个阶段，确保单点失败不阻塞后续清理
// - 调用顺序通过 push 到 callOrder 数组验证

import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted：将 mock 对象与调用顺序记录数组提升到文件顶部
// 避免 vi.mock 工厂内引用触发 TDZ
const {
  callOrder,
  mockAbortAll,
  mockGetStreamBridge,
  mockResetStreamBridge,
  mockResetOpenAIClient,
  mockResetEmbeddingClient,
  mockDisconnectPrisma,
  mockResetPrismaClient,
  mockResetConfigCache,
  mockResetStatusBroadcaster,
  mockShutdownDatabase,
} = vi.hoisted(() => {
  // 调用顺序记录数组（每个 mock 调用时 push 自身标识）
  const callOrder: string[] = [];
  return {
    callOrder,
    // StreamBridge 实例方法
    mockAbortAll: vi.fn(() => {
      callOrder.push('streamBridge.abortAll');
    }),
    mockGetStreamBridge: vi.fn(() => ({
      abortAll: mockAbortAll,
    })),
    mockResetStreamBridge: vi.fn(() => {
      callOrder.push('resetStreamBridge');
    }),
    // AI clients reset
    // biome-ignore lint/style/useNamingConvention: 必须匹配 openai-client.ts 源模块导出的 resetOpenAIClient
    mockResetOpenAIClient: vi.fn(() => {
      callOrder.push('resetOpenAIClient');
    }),
    mockResetEmbeddingClient: vi.fn(() => {
      callOrder.push('resetEmbeddingClient');
    }),
    // PrismaClient
    mockDisconnectPrisma: vi.fn(async () => {
      callOrder.push('disconnectPrisma');
    }),
    mockResetPrismaClient: vi.fn(() => {
      callOrder.push('resetPrismaClient');
    }),
    // AppConfig
    mockResetConfigCache: vi.fn(() => {
      callOrder.push('resetConfigCache');
    }),
    // StatusBroadcaster
    mockResetStatusBroadcaster: vi.fn(() => {
      callOrder.push('resetStatusBroadcaster');
    }),
    // db-init
    mockShutdownDatabase: vi.fn(async () => {
      callOrder.push('shutdownDatabase');
    }),
  };
});

// 注册所有 mock
vi.mock('../infra/ai/stream-bridge', () => ({
  getStreamBridge: mockGetStreamBridge,
  resetStreamBridge: mockResetStreamBridge,
}));

vi.mock('../infra/ai/openai-client', () => ({
  // biome-ignore lint/style/useNamingConvention: 必须匹配源模块导出的 resetOpenAIClient
  resetOpenAIClient: mockResetOpenAIClient,
}));

vi.mock('../infra/ai/embedding-client', () => ({
  resetEmbeddingClient: mockResetEmbeddingClient,
}));

vi.mock('../infra/prisma/client', () => ({
  disconnectPrisma: mockDisconnectPrisma,
  resetPrismaClient: mockResetPrismaClient,
}));

vi.mock('../config', () => ({
  resetConfigCache: mockResetConfigCache,
}));

vi.mock('./status-broadcaster', () => ({
  resetStatusBroadcaster: mockResetStatusBroadcaster,
}));

vi.mock('./db-init', () => ({
  shutdownDatabase: mockShutdownDatabase,
}));

// mock logger（避免实际 logger 输出污染测试）
vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// 静态导入被测模块：vi.mock 已 hoist，mock 此时已生效
import { disposeServices, resetServices } from './service-container';

describe('service-container', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
  });

  describe('disposeServices', () => {
    it('应按反向依赖顺序清理服务', async () => {
      await disposeServices();

      // 验证调用顺序：StreamBridge → AI clients → Prisma → PG
      expect(callOrder).toEqual([
        'streamBridge.abortAll',
        'resetOpenAIClient',
        'resetEmbeddingClient',
        'disconnectPrisma',
        'shutdownDatabase',
      ]);
    });

    it('StreamBridge.abortAll 抛错时仍继续后续清理', async () => {
      mockAbortAll.mockImplementationOnce(() => {
        throw new Error('abortAll failed');
      });

      await disposeServices();

      // 即使 abortAll 抛错，后续清理仍继续
      expect(callOrder).toContain('resetOpenAIClient');
      expect(callOrder).toContain('disconnectPrisma');
      expect(callOrder).toContain('shutdownDatabase');
    });

    it('disconnectPrisma 抛错时仍继续停止 PG', async () => {
      mockDisconnectPrisma.mockRejectedValueOnce(new Error('disconnect failed'));

      await disposeServices();

      // 即使 Prisma 断开失败，仍要停止 PG 子进程
      expect(callOrder).toContain('shutdownDatabase');
      expect(mockShutdownDatabase).toHaveBeenCalledTimes(1);
    });

    it('shutdownDatabase 抛错时不影响已完成的清理', async () => {
      mockShutdownDatabase.mockRejectedValueOnce(new Error('shutdown failed'));

      // 不应抛错（disposeServices 内部 try-catch 包裹）
      await expect(disposeServices()).resolves.toBeUndefined();

      // 前置清理已完成
      expect(callOrder).toContain('streamBridge.abortAll');
      expect(callOrder).toContain('disconnectPrisma');
    });

    it('多次调用应幂等（各模块内部已处理 null 检查）', async () => {
      await disposeServices();
      await disposeServices();

      // 两次调用都完整执行（无短路）
      expect(mockAbortAll).toHaveBeenCalledTimes(2);
      expect(mockShutdownDatabase).toHaveBeenCalledTimes(2);
    });
  });

  describe('resetServices', () => {
    it('应重置所有 6 个模块的缓存', () => {
      resetServices();

      // 验证 6 个 reset 函数均被调用
      expect(mockResetStreamBridge).toHaveBeenCalledTimes(1);
      expect(mockResetOpenAIClient).toHaveBeenCalledTimes(1);
      expect(mockResetEmbeddingClient).toHaveBeenCalledTimes(1);
      expect(mockResetPrismaClient).toHaveBeenCalledTimes(1);
      expect(mockResetConfigCache).toHaveBeenCalledTimes(1);
      expect(mockResetStatusBroadcaster).toHaveBeenCalledTimes(1);
    });

    it('多次调用应幂等', () => {
      resetServices();
      resetServices();

      // 各 reset 函数被调用 2 次
      expect(mockResetStreamBridge).toHaveBeenCalledTimes(2);
      expect(mockResetOpenAIClient).toHaveBeenCalledTimes(2);
    });
  });
});
