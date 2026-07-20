// src/main/infra/repositories/rag.repository.test.ts
// RagRepository 单元测试
//
// 测试策略（设计文档 §4.3 Repository 模式 + §6.4 RAG 检索）：
// - mock PrismaClient.ragDocument CRUD + $transaction + $queryRawUnsafe + $executeRawUnsafe
// - 不 mock age 扩展：RAG Repository 不依赖 AGE，仅依赖 pgvector raw SQL
// - mock logger：避免实际日志输出（虽然本模块当前未使用 logger，保留以备扩展）
// - 验证点：
//   1. createDocument：mimeType undefined → null（DB 兼容）
//   2. insertChunksBatch：空数组短路 + 事务原子性 + vector 字面量拼接
//   3. deleteDocument：存在返回 true / 不存在返回 false
//   4. searchHalfvec：SQL 入参顺序与 vector 字面量格式
//   5. Date 字段序列化为 ISO 字符串（IPC 兼容）
//   6. metadata 类型转换（Prisma JsonValue → Record<string, unknown>）
//
// 注意：
// - vi.hoisted 模式避免 vi.mock factory TDZ（参考 rag.service.test.ts / character.repository.test.ts）
// - $transaction mock 实现：直接调用 cb(mockTx) 让事务内逻辑可测
// - $executeRawUnsafe / $queryRawUnsafe 在 prisma 和 tx 上都需要 mock（insertChunksBatch 用 tx，searchHalfvec 用 prisma）

import type { RagDocument } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted：mock Prisma + $transaction + raw SQL 方法（避免 vi.mock factory TDZ）
const { mockRagDocument, mockTx, mockPrisma } = vi.hoisted(() => {
  // prisma.ragDocument.* 方法 mock
  const mockRagDocument = {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  // $transaction 回调入参：insertChunksBatch 用 tx.$executeRawUnsafe + tx.ragDocument.update
  const mockTx = {
    $executeRawUnsafe: vi.fn(),
    ragDocument: {
      update: vi.fn(),
    },
  };
  // PrismaClient mock：ragDocument 模型 + $transaction + raw SQL 方法
  const mockPrisma = {
    ragDocument: mockRagDocument,
    $transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
    $executeRawUnsafe: vi.fn(),
    $queryRawUnsafe: vi.fn(),
  };
  return { mockRagDocument, mockTx, mockPrisma };
});

// 静态导入被测模块：本模块不依赖 age 扩展和 logger，无需 vi.mock
import { RagRepository } from './rag.repository';

/**
 * 生成 Prisma 原始 RagDocument 记录（Date 字段，未序列化）
 *
 * @param id 文档 ID
 * @param overrides 覆盖字段
 */
function sampleRawRagDocument(
  id: string,
  overrides: Partial<Record<string, unknown>> = {},
): {
  id: string;
  projectId: string;
  title: string;
  source: string | null;
  mimeType: string | null;
  chunksCount: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
} {
  return {
    id,
    projectId: 'p1',
    title: '设定集',
    source: null,
    mimeType: null,
    chunksCount: 0,
    metadata: {},
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('RagRepository', () => {
  let repo: RagRepository;

  beforeEach(() => {
    repo = new RagRepository(mockPrisma as never);
    // mockReset 完全隔离
    mockRagDocument.create.mockReset();
    mockRagDocument.findUnique.mockReset();
    mockRagDocument.findMany.mockReset();
    mockRagDocument.update.mockReset();
    mockRagDocument.delete.mockReset();
    mockTx.$executeRawUnsafe.mockReset();
    mockTx.ragDocument.update.mockReset();
    mockPrisma.$transaction.mockClear();
    mockPrisma.$executeRawUnsafe.mockReset();
    mockPrisma.$queryRawUnsafe.mockReset();
    // 默认 $transaction 直接执行 cb(mockTx)
    mockPrisma.$transaction.mockImplementation(
      async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx),
    );
  });

  describe('createDocument', () => {
    it('应创建文档记录并返回序列化后的 RagDocument', async () => {
      const raw = sampleRawRagDocument('doc1', { chunksCount: 0 });
      mockRagDocument.create.mockResolvedValue(raw);

      const result = await repo.createDocument({
        projectId: 'p1',
        title: '设定集',
      });

      // Prisma.create 收到正确入参：mimeType undefined → null，source 固定 null，metadata 默认 {}
      expect(mockRagDocument.create).toHaveBeenCalledWith({
        data: {
          projectId: 'p1',
          title: '设定集',
          mimeType: null,
          source: null,
          metadata: {},
        },
      });
      // 返回值是 IPC 兼容的 ISO 字符串日期
      expect(result).toMatchObject({
        id: 'doc1',
        title: '设定集',
        chunksCount: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    });

    it('mimeType 显式传入时应写入 DB（如 application/pdf）', async () => {
      const raw = sampleRawRagDocument('doc1', { mimeType: 'application/pdf' });
      mockRagDocument.create.mockResolvedValue(raw);

      await repo.createDocument({
        projectId: 'p1',
        title: 'PDF 设定集',
        mimeType: 'application/pdf',
      });

      expect(mockRagDocument.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          mimeType: 'application/pdf',
          title: 'PDF 设定集',
        }),
      });
    });
  });

  describe('updateChunksCount', () => {
    it('应更新文档的 chunksCount 字段', async () => {
      mockRagDocument.update.mockResolvedValue(sampleRawRagDocument('doc1', { chunksCount: 5 }));

      await repo.updateChunksCount('doc1', 5);

      expect(mockRagDocument.update).toHaveBeenCalledWith({
        where: { id: 'doc1' },
        data: { chunksCount: 5 },
      });
    });
  });

  describe('insertChunksBatch', () => {
    it('chunks 为空时应直接返回（不开启事务）', async () => {
      await repo.insertChunksBatch('doc1', []);

      // 不应调用 $transaction（短路优化）
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      // 不应执行任何 raw SQL
      expect(mockTx.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('应在事务内逐 chunk 插入并更新 chunksCount（保证原子性）', async () => {
      const chunks = [
        { content: '片段一', index: 0, vector: [0.1, 0.2, 0.3] },
        { content: '片段二', index: 1, vector: [0.4, 0.5, 0.6] },
      ];
      mockTx.$executeRawUnsafe.mockResolvedValue(1);
      mockTx.ragDocument.update.mockResolvedValue(sampleRawRagDocument('doc1', { chunksCount: 2 }));

      await repo.insertChunksBatch('doc1', chunks);

      // $transaction 被调用一次
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      // 2 个 chunk → 2 次 $executeRawUnsafe（在事务内）
      expect(mockTx.$executeRawUnsafe).toHaveBeenCalledTimes(2);
      // 事务内更新 chunksCount 为 chunks.length
      expect(mockTx.ragDocument.update).toHaveBeenCalledWith({
        where: { id: 'doc1' },
        data: { chunksCount: 2 },
      });
    });

    it('vector 数组应拼接为 halfvec 字面量格式 [v1,v2,...]', async () => {
      const chunks = [{ content: '片段', index: 0, vector: [0.1, 0.2, 0.3] }];
      mockTx.$executeRawUnsafe.mockResolvedValue(1);
      mockTx.ragDocument.update.mockResolvedValue(sampleRawRagDocument('doc1'));

      await repo.insertChunksBatch('doc1', chunks);

      // 校验 raw SQL 第 4 个参数是 vector 字面量字符串
      const rawCall = mockTx.$executeRawUnsafe.mock.calls[0];
      expect(rawCall?.[0]).toContain('INSERT INTO rag_document_chunks');
      expect(rawCall?.[0]).toContain('$4::halfvec');
      expect(rawCall?.[1]).toBe('doc1'); // $1 documentId
      expect(rawCall?.[2]).toBe('片段'); // $2 content
      expect(rawCall?.[3]).toBe(0); // $3 chunkIndex
      expect(rawCall?.[4]).toBe('[0.1,0.2,0.3]'); // $4 vector 字面量
    });

    it('事务内 chunk 插入失败应抛出（由 Prisma 事务回滚，不留孤儿 chunks）', async () => {
      const chunks = [
        { content: '片段一', index: 0, vector: [0.1] },
        { content: '片段二', index: 1, vector: [0.2] },
      ];
      mockTx.$executeRawUnsafe
        .mockResolvedValueOnce(1) // 第 1 个 chunk 成功
        .mockRejectedValueOnce(new Error('第 2 个 chunk 插入失败')); // 第 2 个失败

      // 应抛错（事务回滚）
      await expect(repo.insertChunksBatch('doc1', chunks)).rejects.toThrow(
        '第 2 个 chunk 插入失败',
      );
    });

    it('chunksCount 更新失败应抛出（事务回滚所有 chunk 插入）', async () => {
      const chunks = [{ content: '片段', index: 0, vector: [0.1] }];
      mockTx.$executeRawUnsafe.mockResolvedValue(1);
      mockTx.ragDocument.update.mockRejectedValue(new Error('chunksCount 更新失败'));

      await expect(repo.insertChunksBatch('doc1', chunks)).rejects.toThrow('chunksCount 更新失败');
    });
  });

  describe('deleteDocument', () => {
    it('文档存在时应删除并返回 true', async () => {
      const raw = sampleRawRagDocument('doc1');
      mockRagDocument.findUnique.mockResolvedValue(raw);
      mockRagDocument.delete.mockResolvedValue(raw);

      const result = await repo.deleteDocument('doc1');

      expect(mockRagDocument.findUnique).toHaveBeenCalledWith({ where: { id: 'doc1' } });
      expect(mockRagDocument.delete).toHaveBeenCalledWith({ where: { id: 'doc1' } });
      expect(result).toBe(true);
    });

    it('文档不存在时应返回 false（不调用 delete）', async () => {
      mockRagDocument.findUnique.mockResolvedValue(null);

      const result = await repo.deleteDocument('nope');

      expect(result).toBe(false);
      expect(mockRagDocument.delete).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('应返回序列化后的文档', async () => {
      const raw = sampleRawRagDocument('doc1', { chunksCount: 3 });
      mockRagDocument.findUnique.mockResolvedValue(raw);

      const result = (await repo.findById('doc1')) as RagDocument;

      expect(mockRagDocument.findUnique).toHaveBeenCalledWith({ where: { id: 'doc1' } });
      expect(result?.id).toBe('doc1');
      expect(result?.chunksCount).toBe(3);
      expect(result?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('文档不存在时应返回 null', async () => {
      mockRagDocument.findUnique.mockResolvedValue(null);

      const result = await repo.findById('nope');

      expect(result).toBeNull();
    });
  });

  describe('listByProject', () => {
    it('应返回按 createdAt 倒序的序列化列表', async () => {
      const rawList = [
        sampleRawRagDocument('d2', { createdAt: new Date('2026-01-02T00:00:00.000Z') }),
        sampleRawRagDocument('d1', { createdAt: new Date('2026-01-01T00:00:00.000Z') }),
      ];
      mockRagDocument.findMany.mockResolvedValue(rawList);

      const result = await repo.listByProject('p1');

      expect(mockRagDocument.findMany).toHaveBeenCalledWith({
        where: { projectId: 'p1' },
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toHaveLength(2);
      // 倒序：d2 在前
      expect(result[0]?.id).toBe('d2');
      expect(result[1]?.id).toBe('d1');
      expect(result[0]?.createdAt).toBe('2026-01-02T00:00:00.000Z');
    });

    it('项目下无文档时应返回空数组', async () => {
      mockRagDocument.findMany.mockResolvedValue([]);

      const result = await repo.listByProject('p1');

      expect(result).toEqual([]);
    });
  });

  describe('searchHalfvec', () => {
    it('应构建正确的 SQL 入参（vector 字面量 + projectId + topK）', async () => {
      const mockResults = [
        { chunkId: 'chunk1', documentId: 'doc1', content: '片段一', score: 0.95 },
      ];
      mockPrisma.$queryRawUnsafe.mockResolvedValue(mockResults);

      const result = await repo.searchHalfvec('p1', [0.1, 0.2, 0.3], 5);

      // 校验 $queryRawUnsafe 调用：SQL + 3 个参数
      const rawCall = mockPrisma.$queryRawUnsafe.mock.calls[0];
      expect(rawCall?.[0]).toContain('1 - (c.embedding <=> $1::halfvec) AS score');
      expect(rawCall?.[0]).toContain('JOIN rag_documents d ON d.id = c."documentId"');
      expect(rawCall?.[0]).toContain('WHERE d."projectId" = $2');
      expect(rawCall?.[0]).toContain('ORDER BY c.embedding <=> $1::halfvec');
      expect(rawCall?.[0]).toContain('LIMIT $3');
      // 参数顺序：vectorLiteral, projectId, topK
      expect(rawCall?.[1]).toBe('[0.1,0.2,0.3]');
      expect(rawCall?.[2]).toBe('p1');
      expect(rawCall?.[3]).toBe(5);
      expect(result).toEqual(mockResults);
    });

    it('检索结果为空时应返回空数组', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      const result = await repo.searchHalfvec('p1', [0.1], 10);

      expect(result).toEqual([]);
    });

    it('单维向量也应正确拼接为 halfvec 字面量', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await repo.searchHalfvec('p1', [0.5], 1);

      expect(mockPrisma.$queryRawUnsafe.mock.calls[0]?.[1]).toBe('[0.5]');
    });
  });

  describe('序列化行为', () => {
    it('Date 字段应序列化为 ISO 字符串（IPC 兼容）', async () => {
      const raw = sampleRawRagDocument('doc1', {
        createdAt: new Date('2026-07-20T10:30:00.000Z'),
      });
      mockRagDocument.findUnique.mockResolvedValue(raw);

      const result = (await repo.findById('doc1')) as RagDocument;

      expect(result.createdAt).toBe('2026-07-20T10:30:00.000Z');
    });

    it('null 字段应保留 null 语义（source/mimeType 可空字段）', async () => {
      const raw = sampleRawRagDocument('doc1', { source: null, mimeType: null });
      mockRagDocument.findUnique.mockResolvedValue(raw);

      const result = (await repo.findById('doc1')) as RagDocument;

      expect(result.source).toBeNull();
      expect(result.mimeType).toBeNull();
    });

    it('metadata 应从 Prisma JsonValue 转换为 Record<string, unknown>', async () => {
      const raw = sampleRawRagDocument('doc1', {
        metadata: { author: 'test', pages: 10 },
      });
      mockRagDocument.findUnique.mockResolvedValue(raw);

      const result = (await repo.findById('doc1')) as RagDocument;

      expect(result.metadata).toEqual({ author: 'test', pages: 10 });
    });
  });
});
