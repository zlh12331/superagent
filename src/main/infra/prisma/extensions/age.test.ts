// src/main/infra/prisma/extensions/age.test.ts
// AGE 扩展管理器单元测试
//
// 测试策略：
// 1. vi.mock('@prisma/client') 替换 PrismaClient 构造函数
// 2. 使用 vi.fn(function () { return mockInstance; }) 避免 [[Construct]] 陷阱（Phase 3b 经验）
// 3. 静态 import 被测模块（参考 Task 1 pg-installer.test.ts，避免 vitest 4 dynamic import hoisting 问题）
// 4. 不连接真实 PG，仅验证 SQL 包裹逻辑与返回值传递

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// mockPrisma：模拟 PrismaClient 实例的 raw SQL 方法
const mockPrisma = {
  $executeRawUnsafe: vi.fn().mockResolvedValue(1),
  $queryRawUnsafe: vi.fn().mockResolvedValue([]),
};

vi.mock('@prisma/client', () => ({
  // biome-ignore lint/complexity/useArrowFunction: 需要 [[Construct]] 调用
  // biome-ignore lint/style/useNamingConvention: 保留 PrismaClient 大写以匹配 Prisma SDK 类名
  PrismaClient: vi.fn(function () {
    return mockPrisma;
  }),
}));

// 静态导入被测模块：vi.mock 已 hoist 到文件顶部，mock 此时已生效
import {
  createCharacterVertex,
  createRelationEdge,
  ensureAgeExtension,
  executeCypher,
  queryCypher,
} from './age';

describe('AGE 扩展管理器', () => {
  beforeEach(() => {
    // mockReset 而非 clearAllMocks，确保完全隔离（计划注意事项 #3）
    mockPrisma.$executeRawUnsafe.mockReset();
    mockPrisma.$queryRawUnsafe.mockReset();
    mockPrisma.$executeRawUnsafe.mockResolvedValue(1);
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('ensureAgeExtension', () => {
    it('加载成功应返回 true', async () => {
      const result = await ensureAgeExtension(mockPrisma as never);
      expect(result).toBe(true);
      // 应执行 2 次 $executeRawUnsafe（AGE_INIT_SQL + CREATE_GRAPH_SQL）
      expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    });

    it('加载失败应返回 false（不抛错）', async () => {
      mockPrisma.$executeRawUnsafe.mockRejectedValueOnce(new Error('AGE not compatible'));
      const result = await ensureAgeExtension(mockPrisma as never);
      expect(result).toBe(false);
    });
  });

  describe('executeCypher', () => {
    it('应正确包裹 Cypher 语句并调用 $executeRawUnsafe', async () => {
      await executeCypher(mockPrisma as never, 'CREATE (n:Character {name: "test"})');
      expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('ag_catalog.cypher'),
      );
      expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('CREATE (n:Character {name: "test"})'),
      );
    });

    it('应使用 novel_graph 作为 Graph 名', async () => {
      await executeCypher(mockPrisma as never, 'RETURN 1');
      const sqlArg = mockPrisma.$executeRawUnsafe.mock.calls[0]?.[0] as string;
      expect(sqlArg).toContain("'novel_graph'");
    });

    it('应返回受影响行数', async () => {
      mockPrisma.$executeRawUnsafe.mockResolvedValueOnce(42);
      const result = await executeCypher(mockPrisma as never, 'CREATE (n:Test)');
      expect(result).toBe(42);
    });
  });

  describe('queryCypher', () => {
    it('应正确包裹 Cypher 语句并调用 $queryRawUnsafe', async () => {
      await queryCypher(mockPrisma as never, 'MATCH (n) RETURN n');
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('ag_catalog.cypher'),
      );
    });

    it('应返回查询结果数组', async () => {
      const mockRows = [{ result: 'data1' }, { result: 'data2' }];
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce(mockRows);
      const result = await queryCypher(mockPrisma as never, 'MATCH (n) RETURN n');
      expect(result).toEqual(mockRows);
    });
  });

  describe('createCharacterVertex', () => {
    it('应创建 Character 顶点', async () => {
      await createCharacterVertex(mockPrisma as never, {
        characterId: 'c1',
        name: '主角',
        role: 'PROTAGONIST',
      });
      const sqlArg = mockPrisma.$executeRawUnsafe.mock.calls[0]?.[0] as string;
      expect(sqlArg).toContain(':Character');
      expect(sqlArg).toContain("characterId: 'c1'");
      expect(sqlArg).toContain("name: '主角'");
      expect(sqlArg).toContain("role: 'PROTAGONIST'");
    });
  });

  describe('createRelationEdge', () => {
    it('应创建 RELATION 边（含 description 与 chapterId）', async () => {
      await createRelationEdge(mockPrisma as never, {
        fromCharacterId: 'c1',
        toCharacterId: 'c2',
        type: 'friend',
        description: '好友',
        chapterId: 'ch1',
      });
      const sqlArg = mockPrisma.$executeRawUnsafe.mock.calls[0]?.[0] as string;
      // Cypher 单 MATCH 多模式语法：MATCH (a:...), (b:...)（b 前无 MATCH 关键字）
      expect(sqlArg).toContain("MATCH (a:Character {characterId: 'c1'})");
      expect(sqlArg).toContain("(b:Character {characterId: 'c2'})");
      expect(sqlArg).toContain(':RELATION');
      expect(sqlArg).toContain("type: 'friend'");
      expect(sqlArg).toContain("description: '好友'");
      expect(sqlArg).toContain("chapterId: 'ch1'");
    });

    it('应创建 RELATION 边（仅 type 必填）', async () => {
      await createRelationEdge(mockPrisma as never, {
        fromCharacterId: 'c1',
        toCharacterId: 'c2',
        type: 'enemy',
      });
      const sqlArg = mockPrisma.$executeRawUnsafe.mock.calls[0]?.[0] as string;
      expect(sqlArg).toContain("type: 'enemy'");
      expect(sqlArg).not.toContain('description');
      expect(sqlArg).not.toContain('chapterId');
    });
  });
});
