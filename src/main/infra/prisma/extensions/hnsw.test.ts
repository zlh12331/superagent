// src/main/infra/prisma/extensions/hnsw.test.ts
// HNSW 索引初始化单元测试
//
// 测试策略：
// 1. vi.mock('@prisma/client') 替换 PrismaClient 构造函数
// 2. 使用 vi.fn(function () { return mockInstance; }) 避免 [[Construct]] 陷阱（Phase 3b 经验）
// 3. 静态 import 被测模块（参考 age.test.ts，避免 vitest 4 dynamic import hoisting 问题）
// 4. 不连接真实 PG，仅验证 SQL 拼接与顺序、幂等性、错误传递

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// mockPrisma：模拟 PrismaClient 实例的 $executeRawUnsafe 方法
const mockPrisma = {
  $executeRawUnsafe: vi.fn().mockResolvedValue(1),
};

vi.mock('@prisma/client', () => ({
  // biome-ignore lint/complexity/useArrowFunction: 需要 [[Construct]] 调用
  // biome-ignore lint/style/useNamingConvention: 保留 PrismaClient 大写以匹配 Prisma SDK 类名
  PrismaClient: vi.fn(function () {
    return mockPrisma;
  }),
}));

// 静态导入被测模块：vi.mock 已 hoist 到文件顶部，mock 此时已生效
import { ensureHnswIndex, resetHnswIndexState } from './hnsw';

describe('HNSW 索引初始化', () => {
  beforeEach(() => {
    // mockReset 而非 clearAllMocks，确保完全隔离（计划注意事项 #3）
    mockPrisma.$executeRawUnsafe.mockReset();
    mockPrisma.$executeRawUnsafe.mockResolvedValue(1);
    // 每个测试前重置初始化状态，避免上一个测试污染（幂等性测试特别需要）
    resetHnswIndexState();
  });

  afterEach(() => {
    vi.clearAllMocks();
    // 测试后清理状态，保证测试间完全隔离
    resetHnswIndexState();
  });

  it('应按顺序创建 pg_trgm + HNSW + trgm + 复合索引', async () => {
    await ensureHnswIndex(mockPrisma as never);

    // 应执行 4 个 $executeRawUnsafe 调用
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(4);

    // 验证顺序
    const calls = mockPrisma.$executeRawUnsafe.mock.calls.map((c) => c[0] as string);
    expect(calls[0]).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    expect(calls[1]).toContain('USING hnsw');
    expect(calls[1]).toContain('halfvec_cosine_ops');
    expect(calls[1]).toContain('m = 16');
    expect(calls[1]).toContain('ef_construction = 64');
    expect(calls[2]).toContain('idx_chapters_content_trgm');
    expect(calls[2]).toContain('gin_trgm_ops');
    expect(calls[3]).toContain('idx_chapters_project_order');
    expect(calls[3]).toContain('project_id, sort_order');
  });

  it('HNSW 索引名应为 idx_rag_chunks_embedding', async () => {
    await ensureHnswIndex(mockPrisma as never);
    const hnswCall = mockPrisma.$executeRawUnsafe.mock.calls[1]?.[0] as string;
    expect(hnswCall).toContain('idx_rag_chunks_embedding');
  });

  it('已初始化时应跳过（幂等）', async () => {
    await ensureHnswIndex(mockPrisma as never);
    await ensureHnswIndex(mockPrisma as never);

    // 第二次调用应跳过，总共只 4 次调用
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(4);
  });

  it('resetHnswIndexState 应重置初始化状态', async () => {
    await ensureHnswIndex(mockPrisma as never);
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(4);

    resetHnswIndexState();
    await ensureHnswIndex(mockPrisma as never);
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(8);
  });

  it('索引创建失败应抛错', async () => {
    mockPrisma.$executeRawUnsafe.mockRejectedValueOnce(new Error('halfvec type not found'));
    await expect(ensureHnswIndex(mockPrisma as never)).rejects.toThrow('halfvec type not found');
  });
});
