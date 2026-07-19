// src/main/__tests__/helpers/mock-prisma.ts
// 共享 PrismaClient mock 工具
// 所有 service 测试统一使用，避免重复定义 mock

import { vi } from 'vitest';

/** Prisma 各 model 的 mock 接口（覆盖 service 用到的方法） */
export interface PrismaModelMock {
  findUnique: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
}

/** 创建一个 Prisma model mock（含全部 CRUD 方法） */
export function createPrismaModelMock(): PrismaModelMock {
  return {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    upsert: vi.fn(),
    count: vi.fn(),
    deleteMany: vi.fn(),
    updateMany: vi.fn(),
  };
}

/** 全局 mock PrismaClient 实例（service 通过 getPrismaClient() 获取） */
export const mockPrismaClient: Record<string, PrismaModelMock> = {};

/** 重置所有 mock（每个测试用例 beforeEach 调用） */
export function resetMocks(): void {
  for (const model of Object.values(mockPrismaClient)) {
    model.findUnique.mockReset();
    model.findMany.mockReset();
    model.create.mockReset();
    model.update.mockReset();
    model.delete.mockReset();
    model.upsert.mockReset();
    model.count.mockReset();
    model.deleteMany.mockReset();
    model.updateMany.mockReset();
  }
}

/** 创建完整 mock PrismaClient（覆盖所有 service 用到的 model） */
export function createMockPrismaClient(): void {
  for (const modelName of [
    'project',
    'chapter',
    'character',
    'worldview',
    'chatSession',
    'chatMessage',
    'projectSetting',
    'appSetting',
    'ragDocument',
    'ragDocumentChunk',
    'aiUsageLog',
  ]) {
    mockPrismaClient[modelName] = createPrismaModelMock();
  }
}

// 模块加载时初始化一次
createMockPrismaClient();
