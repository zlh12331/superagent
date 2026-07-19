// src/main/services/rag.service.test.ts
// rag.service 单元测试
// 设计文档 §4.2 rag.service / §6.2 RagDocument / RagDocumentChunk 模型

import { ErrorCode } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaClient, resetMocks } from '../__tests__/helpers/mock-prisma';

const { mockRagDocument, mockEmbedTexts, mockExecuteRaw, mockQueryRaw } = vi.hoisted(() => ({
  mockRagDocument: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  mockEmbedTexts: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockQueryRaw: vi.fn(),
}));

vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => ({
    ...mockPrismaClient,
    ragDocument: mockRagDocument,
    $executeRawUnsafe: mockExecuteRaw,
    $queryRawUnsafe: mockQueryRaw,
  }),
}));

vi.mock('./embedding.service', () => ({
  embedTexts: mockEmbedTexts,
}));

import {
  deleteRagDocument,
  ingestDocument,
  listRagDocuments,
  searchSimilarChunks,
} from './rag.service';

describe('rag.service', () => {
  beforeEach(() => {
    resetMocks();
    mockRagDocument.findUnique.mockReset();
    mockRagDocument.findMany.mockReset();
    mockRagDocument.create.mockReset();
    mockRagDocument.update.mockReset();
    mockRagDocument.delete.mockReset();
    mockEmbedTexts.mockReset();
    mockExecuteRaw.mockReset();
    mockQueryRaw.mockReset();
  });

  describe('ingestDocument', () => {
    it('应按段落切片 → 嵌入 → 建文档 → 逐 chunk raw SQL 插入 → 更新 chunksCount', async () => {
      // 3 个短段落 → 1 个 chunk（累加后未超 800 字符）
      const fileContent = '第一段内容。\n\n第二段内容。\n\n第三段内容。';
      mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);
      mockRagDocument.create.mockResolvedValue({
        id: 'doc1',
        projectId: 'p1',
        title: '设定集',
        source: null,
        mimeType: null,
        chunksCount: 0,
        metadata: {},
        createdAt: new Date(),
      });
      mockExecuteRaw.mockResolvedValue(1);
      mockRagDocument.update.mockResolvedValue({});

      const result = await ingestDocument({
        projectId: 'p1',
        title: '设定集',
        fileContent,
      });

      // 切片结果：3 段落累加为 1 chunk（'第一段内容。\n\n第二段内容。\n\n第三段内容。'）
      expect(mockEmbedTexts).toHaveBeenCalledWith(['第一段内容。\n\n第二段内容。\n\n第三段内容。']);
      expect(mockRagDocument.create).toHaveBeenCalledWith({
        data: {
          projectId: 'p1',
          title: '设定集',
          mimeType: null,
          source: null,
          metadata: {},
        },
      });
      // 1 个 chunk → 1 次 raw SQL 插入
      expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
      const [sql, docId, content, chunkIndex, vectorLiteral] = mockExecuteRaw.mock.calls[0] as [
        string,
        string,
        string,
        number,
        string,
      ];
      expect(sql).toContain('INSERT INTO rag_document_chunks');
      expect(sql).toContain('::halfvec');
      expect(docId).toBe('doc1');
      expect(content).toBe('第一段内容。\n\n第二段内容。\n\n第三段内容。');
      expect(chunkIndex).toBe(0);
      expect(vectorLiteral).toBe('[0.1,0.2,0.3]');
      // chunksCount 更新
      expect(mockRagDocument.update).toHaveBeenCalledWith({
        where: { id: 'doc1' },
        data: { chunksCount: 1 },
      });
      expect(result).toEqual({ documentId: 'doc1', chunksCount: 1 });
    });

    it('长文档应切分为多个 chunk（累加超 800 字符时截断）', async () => {
      // 构造 3 个 500 字符段落：段落1+段落2 累加超 800 → chunk1=段落1, chunk2=段落2, 段落3 → chunk3
      const para = '字'.repeat(500);
      const fileContent = `${para}\n\n${para}\n\n${para}`;
      mockEmbedTexts.mockResolvedValue([[0.1], [0.2], [0.3]]);
      mockRagDocument.create.mockResolvedValue({ id: 'doc1' });
      mockExecuteRaw.mockResolvedValue(1);
      mockRagDocument.update.mockResolvedValue({});

      const result = await ingestDocument({ projectId: 'p1', title: 'T', fileContent });

      expect(mockEmbedTexts).toHaveBeenCalledWith([para, para, para]);
      expect(mockExecuteRaw).toHaveBeenCalledTimes(3);
      expect(result.chunksCount).toBe(3);
    });

    it('单段落超 800 字符应硬切为多个连续 chunk', async () => {
      const fileContent = '字'.repeat(1700); // 1700 / 800 → 3 chunk（800 + 800 + 100）
      mockEmbedTexts.mockResolvedValue([[0.1], [0.2], [0.3]]);
      mockRagDocument.create.mockResolvedValue({ id: 'doc1' });
      mockExecuteRaw.mockResolvedValue(1);
      mockRagDocument.update.mockResolvedValue({});

      const result = await ingestDocument({ projectId: 'p1', title: 'T', fileContent });

      const chunks = mockEmbedTexts.mock.calls[0]?.[0] as string[];
      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toHaveLength(800);
      expect(chunks[1]).toHaveLength(800);
      expect(chunks[2]).toHaveLength(100);
      expect(result.chunksCount).toBe(3);
    });

    it('文档超过 200_000 字符应抛 RAG_DOCUMENT_TOO_LARGE（不调用嵌入）', async () => {
      const fileContent = '字'.repeat(200_001);

      await expect(
        ingestDocument({ projectId: 'p1', title: 'T', fileContent }),
      ).rejects.toMatchObject({ code: ErrorCode.RAG_DOCUMENT_TOO_LARGE });
      expect(mockEmbedTexts).not.toHaveBeenCalled();
      expect(mockRagDocument.create).not.toHaveBeenCalled();
    });

    it('切片后无有效内容应返回 chunksCount=0（不调用嵌入）', async () => {
      mockRagDocument.create.mockResolvedValue({ id: 'doc1' });
      mockRagDocument.update.mockResolvedValue({});

      const result = await ingestDocument({
        projectId: 'p1',
        title: 'T',
        fileContent: '\n\n\n\n', // 纯空行
      });

      expect(mockEmbedTexts).not.toHaveBeenCalled();
      expect(mockExecuteRaw).not.toHaveBeenCalled();
      expect(result).toEqual({ documentId: 'doc1', chunksCount: 0 });
    });
  });

  describe('searchSimilarChunks', () => {
    it('应生成查询向量 → raw SQL 检索 → 按 threshold 过滤映射', async () => {
      mockEmbedTexts.mockResolvedValue([[0.9, 0.8]]);
      mockQueryRaw.mockResolvedValue([
        { chunkId: 'c1', documentId: 'd1', content: '片段一', score: 0.95 },
        { chunkId: 'c2', documentId: 'd1', content: '片段二', score: 0.5 }, // 低于默认 threshold 0.7
      ]);

      const result = await searchSimilarChunks({
        projectId: 'p1',
        query: '主角身世',
        topK: 5,
        threshold: 0.7,
      });

      expect(mockEmbedTexts).toHaveBeenCalledWith(['主角身世']);
      const [sql, vectorLiteral, projectId, topK] = mockQueryRaw.mock.calls[0] as [
        string,
        string,
        string,
        number,
      ];
      expect(sql).toContain('embedding <=>');
      expect(sql).toContain('rag_document_chunks');
      expect(vectorLiteral).toBe('[0.9,0.8]');
      expect(projectId).toBe('p1');
      expect(topK).toBe(5);
      // 只保留 score >= 0.7 的结果
      expect(result).toEqual([{ chunkId: 'c1', documentId: 'd1', content: '片段一', score: 0.95 }]);
    });

    it('检索结果为空应返回空数组（不抛异常）', async () => {
      mockEmbedTexts.mockResolvedValue([[0.1]]);
      mockQueryRaw.mockResolvedValue([]);

      const result = await searchSimilarChunks({
        projectId: 'p1',
        query: 'q',
        topK: 5,
        threshold: 0.7,
      });

      expect(result).toEqual([]);
    });

    it('嵌入返回空向量数组应抛 INTERNAL_ERROR', async () => {
      mockEmbedTexts.mockResolvedValue([]);

      await expect(
        searchSimilarChunks({ projectId: 'p1', query: 'q', topK: 5, threshold: 0.7 }),
      ).rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR });
    });
  });

  describe('listRagDocuments', () => {
    it('应返回文档列表（按 createdAt 倒序）', async () => {
      const now = new Date();
      mockRagDocument.findMany.mockResolvedValue([
        {
          id: 'd1',
          projectId: 'p1',
          title: '设定集',
          source: null,
          mimeType: 'text/plain',
          chunksCount: 3,
          metadata: {},
          createdAt: now,
        },
      ]);

      const result = await listRagDocuments('p1');

      expect(mockRagDocument.findMany).toHaveBeenCalledWith({
        where: { projectId: 'p1' },
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'd1',
        title: '设定集',
        chunksCount: 3,
        createdAt: now.toISOString(),
      });
    });
  });

  describe('deleteRagDocument', () => {
    it('应删除文档（DB 级联删除 chunks）', async () => {
      mockRagDocument.findUnique.mockResolvedValue({ id: 'd1' });
      mockRagDocument.delete.mockResolvedValue({});

      const result = await deleteRagDocument('d1');

      expect(mockRagDocument.delete).toHaveBeenCalledWith({ where: { id: 'd1' } });
      expect(result).toEqual({ id: 'd1' });
    });

    it('文档不存在应抛 NOT_FOUND', async () => {
      mockRagDocument.findUnique.mockResolvedValue(null);

      await expect(deleteRagDocument('nope')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });
});
