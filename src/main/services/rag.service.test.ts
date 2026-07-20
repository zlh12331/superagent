// src/main/services/rag.service.test.ts
// rag.service 单元测试
// 设计文档 §4.2 rag.service / §6.2 RagDocument / RagDocumentChunk 模型
//
// 测试策略（设计文档 §4.3 Repository 模式）：
// - mock RagRepository：service 只做编排，Repository 已独立测试覆盖 SQL + halfvec 细节
// - mock embedding.service（embedTexts）：嵌入是外部依赖，service 只校验返回数量
// - mock pdf-parser：PDF 解析是外部依赖，默认未实现，PDF 测试用例单独 mockResolveValue
// - 验证 service 编排逻辑：切片 → 嵌入 → 数量校验 → Repository 写入

import { AppError, ErrorCode } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted：mock RagRepository + getPrismaClient + embedTexts + parsePdfToText
// 避免 vi.mock factory TDZ（参考 db-init.test.ts）
const { mockRepo, MockRagRepository, mockEmbedTexts, mockParsePdfToText } = vi.hoisted(() => {
  const mockRepo = {
    createDocument: vi.fn(),
    updateChunksCount: vi.fn(),
    insertChunksBatch: vi.fn(),
    deleteDocument: vi.fn(),
    findById: vi.fn(),
    listByProject: vi.fn(),
    searchHalfvec: vi.fn(),
  };
  // 用 class 表达式 mock `new RagRepository(prisma)` 返回 mockRepo 实例
  class MockRagRepository {
    createDocument = mockRepo.createDocument;
    updateChunksCount = mockRepo.updateChunksCount;
    insertChunksBatch = mockRepo.insertChunksBatch;
    deleteDocument = mockRepo.deleteDocument;
    findById = mockRepo.findById;
    listByProject = mockRepo.listByProject;
    searchHalfvec = mockRepo.searchHalfvec;
  }
  return {
    mockRepo,
    // biome-ignore lint/style/useNamingConvention: 必须匹配源 class 名 RagRepository
    MockRagRepository,
    mockEmbedTexts: vi.fn(),
    mockParsePdfToText: vi.fn(),
  };
});

// mock RagRepository 类
vi.mock('../infra/repositories/rag.repository', () => ({
  // biome-ignore lint/style/useNamingConvention: 必须匹配源 class 名 RagRepository
  RagRepository: MockRagRepository,
}));

// mock getPrismaClient（service 内部调用拿 prisma 引用，传给 MockRepository 但不会真实使用）
vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => ({}),
}));

vi.mock('./embedding.service', () => ({
  embedTexts: mockEmbedTexts,
}));

vi.mock('../infra/rag/pdf-parser', () => ({
  parsePdfToText: mockParsePdfToText,
}));

import {
  deleteRagDocument,
  ingestDocument,
  listRagDocuments,
  searchSimilarChunks,
} from './rag.service';

/** 生成样本 RagDocument（IPC 兼容的字符串日期格式） */
function sampleRagDocument(
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
  createdAt: string;
} {
  return {
    id,
    projectId: 'p1',
    title: 'T',
    source: null,
    mimeType: null,
    chunksCount: 0,
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('rag.service', () => {
  beforeEach(() => {
    mockRepo.createDocument.mockReset();
    mockRepo.updateChunksCount.mockReset();
    mockRepo.insertChunksBatch.mockReset();
    mockRepo.deleteDocument.mockReset();
    mockRepo.findById.mockReset();
    mockRepo.listByProject.mockReset();
    mockRepo.searchHalfvec.mockReset();
    mockEmbedTexts.mockReset();
    mockParsePdfToText.mockReset();
  });

  describe('ingestDocument', () => {
    it('应按段落切片 → 嵌入 → Repository.createDocument → Repository.insertChunksBatch', async () => {
      // 3 个短段落 → 1 个 chunk（累加后未超 800 字符）
      const fileContent = '第一段内容。\n\n第二段内容。\n\n第三段内容。';
      mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);
      mockRepo.createDocument.mockResolvedValue(sampleRagDocument('doc1'));
      mockRepo.insertChunksBatch.mockResolvedValue(undefined);

      const result = await ingestDocument({
        projectId: 'p1',
        title: '设定集',
        fileContent,
      });

      // 切片结果：3 段落累加为 1 chunk
      expect(mockEmbedTexts).toHaveBeenCalledWith(['第一段内容。\n\n第二段内容。\n\n第三段内容。']);
      // Repository.createDocument 收到正确入参
      expect(mockRepo.createDocument).toHaveBeenCalledWith({
        projectId: 'p1',
        title: '设定集',
        mimeType: undefined,
      });
      // Repository.insertChunksBatch 收到 1 个 chunk（含 vector）
      expect(mockRepo.insertChunksBatch).toHaveBeenCalledTimes(1);
      const [documentId, chunks] = mockRepo.insertChunksBatch.mock.calls[0] as [
        string,
        { content: string; index: number; vector: number[] }[],
      ];
      expect(documentId).toBe('doc1');
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.content).toBe('第一段内容。\n\n第二段内容。\n\n第三段内容。');
      expect(chunks[0]?.index).toBe(0);
      expect(chunks[0]?.vector).toEqual([0.1, 0.2, 0.3]);
      expect(result).toEqual({ documentId: 'doc1', chunksCount: 1 });
    });

    it('长文档应切分为多个 chunk（累加超 800 字符时截断）', async () => {
      // 构造 3 个 500 字符段落：段落1+段落2 累加超 800 → chunk1=段落1, chunk2=段落2, 段落3 → chunk3
      const para = '字'.repeat(500);
      const fileContent = `${para}\n\n${para}\n\n${para}`;
      mockEmbedTexts.mockResolvedValue([[0.1], [0.2], [0.3]]);
      mockRepo.createDocument.mockResolvedValue(sampleRagDocument('doc1'));
      mockRepo.insertChunksBatch.mockResolvedValue(undefined);

      const result = await ingestDocument({ projectId: 'p1', title: 'T', fileContent });

      expect(mockEmbedTexts).toHaveBeenCalledWith([para, para, para]);
      // insertChunksBatch 收到 3 个 chunk
      const chunks = mockRepo.insertChunksBatch.mock.calls[0]?.[1] as {
        content: string;
        index: number;
        vector: number[];
      }[];
      expect(chunks).toHaveLength(3);
      expect(result.chunksCount).toBe(3);
    });

    it('单段落超 800 字符应硬切为多个连续 chunk', async () => {
      const fileContent = '字'.repeat(1700); // 1700 / 800 → 3 chunk（800 + 800 + 100）
      mockEmbedTexts.mockResolvedValue([[0.1], [0.2], [0.3]]);
      mockRepo.createDocument.mockResolvedValue(sampleRagDocument('doc1'));
      mockRepo.insertChunksBatch.mockResolvedValue(undefined);

      const result = await ingestDocument({ projectId: 'p1', title: 'T', fileContent });

      const chunks = mockEmbedTexts.mock.calls[0]?.[0] as string[];
      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toHaveLength(800);
      expect(chunks[1]).toHaveLength(800);
      expect(chunks[2]).toHaveLength(100);
      expect(result.chunksCount).toBe(3);
    });

    it('文档超过 200_000 字符应抛 RAG_DOCUMENT_TOO_LARGE（不调用嵌入/Repository）', async () => {
      const fileContent = '字'.repeat(200_001);

      await expect(
        ingestDocument({ projectId: 'p1', title: 'T', fileContent }),
      ).rejects.toMatchObject({ code: ErrorCode.RAG_DOCUMENT_TOO_LARGE });
      expect(mockEmbedTexts).not.toHaveBeenCalled();
      expect(mockRepo.createDocument).not.toHaveBeenCalled();
      expect(mockRepo.insertChunksBatch).not.toHaveBeenCalled();
    });

    it('切片后无有效内容应返回 chunksCount=0（不调用嵌入/insertChunksBatch）', async () => {
      mockRepo.createDocument.mockResolvedValue(sampleRagDocument('doc1'));

      const result = await ingestDocument({
        projectId: 'p1',
        title: 'T',
        fileContent: '\n\n\n\n', // 纯空行
      });

      expect(mockEmbedTexts).not.toHaveBeenCalled();
      expect(mockRepo.insertChunksBatch).not.toHaveBeenCalled();
      expect(result).toEqual({ documentId: 'doc1', chunksCount: 0 });
    });

    it('嵌入向量数量与切片数量不一致应抛 INTERNAL_ERROR', async () => {
      // 用单段落超 800 字符硬切，确保产生 2 个 chunk
      // '段落1'.repeat(500) = 1500 字符 → 硬切成 800 + 700 = 2 个 chunk
      const fileContent = '段落1'.repeat(500);
      mockEmbedTexts.mockResolvedValue([[0.1]]); // 只返回 1 个向量（与 2 个 chunk 不一致）
      mockRepo.createDocument.mockResolvedValue(sampleRagDocument('doc1'));

      await expect(
        ingestDocument({ projectId: 'p1', title: 'T', fileContent }),
      ).rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR });
      // 失败前不应调用 insertChunksBatch
      expect(mockRepo.insertChunksBatch).not.toHaveBeenCalled();
    });

    it('PDF（mimeType=application/pdf）应先解码 base64 → 解析文本 → 走原切片+嵌入流程', async () => {
      // 模拟 pdf-parser 返回的解析文本（3 个段落 → 1 个 chunk）
      const parsedText = '第一段内容。\n\n第二段内容。\n\n第三段内容。';
      mockParsePdfToText.mockResolvedValue(parsedText);
      mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);
      mockRepo.createDocument.mockResolvedValue(sampleRagDocument('doc-pdf'));
      mockRepo.insertChunksBatch.mockResolvedValue(undefined);

      // fileContent 是渲染层用 FileReader.readAsDataURL 得到的 base64 字符串
      // 'JVBERi0xLjQK' 是 '%PDF-1.4\n' 的 base64 编码（pdf-parser 已 mock 无需真实 PDF）
      const result = await ingestDocument({
        projectId: 'p1',
        title: '设定集',
        fileContent: 'JVBERi0xLjQK',
        mimeType: 'application/pdf',
      });

      // 校验：parsePdfToText 被调用，且参数是 Uint8Array（base64 解码后的字节）
      expect(mockParsePdfToText).toHaveBeenCalledTimes(1);
      const [uint8] = mockParsePdfToText.mock.calls[0] as [Uint8Array];
      expect(uint8).toBeInstanceOf(Uint8Array);
      // 'JVBERi0xLjQK' base64 解码后应为 '%PDF-1.4\n'（9 字节）
      expect(uint8.byteLength).toBe(9);
      // 后续流程：嵌入收到解析后的文本切片
      expect(mockEmbedTexts).toHaveBeenCalledWith(['第一段内容。\n\n第二段内容。\n\n第三段内容。']);
      // Repository.createDocument 收到 mimeType='application/pdf'
      expect(mockRepo.createDocument).toHaveBeenCalledWith({
        projectId: 'p1',
        title: '设定集',
        mimeType: 'application/pdf',
      });
      // 1 个 chunk → Repository.insertChunksBatch 调用 1 次
      expect(mockRepo.insertChunksBatch).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ documentId: 'doc-pdf', chunksCount: 1 });
    });

    it('PDF 解析失败应抛 RAG_DOCUMENT_PARSE_FAILED（不调用嵌入/Repository）', async () => {
      // 模拟 pdf-parser 抛 AppError(RAG_DOCUMENT_PARSE_FAILED)
      mockParsePdfToText.mockRejectedValue(
        new AppError(ErrorCode.RAG_DOCUMENT_PARSE_FAILED, 'PDF 解析失败：损坏的文件'),
      );

      await expect(
        ingestDocument({
          projectId: 'p1',
          title: 'T',
          fileContent: 'aGVsbG8=',
          mimeType: 'application/pdf',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.RAG_DOCUMENT_PARSE_FAILED });

      // 解析失败：不应调用嵌入、不应调用 Repository
      expect(mockEmbedTexts).not.toHaveBeenCalled();
      expect(mockRepo.createDocument).not.toHaveBeenCalled();
      expect(mockRepo.insertChunksBatch).not.toHaveBeenCalled();
    });

    it('PDF 解析后文本超过 MAX_DOCUMENT_SIZE 应抛 RAG_DOCUMENT_TOO_LARGE', async () => {
      // 模拟 pdf-parser 返回超长文本（200_001 字符）
      mockParsePdfToText.mockResolvedValue('字'.repeat(200_001));

      await expect(
        ingestDocument({
          projectId: 'p1',
          title: 'T',
          fileContent: 'aGVsbG8=',
          mimeType: 'application/pdf',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.RAG_DOCUMENT_TOO_LARGE });

      // 超大文档：不应调用嵌入、不应调用 Repository
      expect(mockEmbedTexts).not.toHaveBeenCalled();
      expect(mockRepo.createDocument).not.toHaveBeenCalled();
    });
  });

  describe('searchSimilarChunks', () => {
    it('应生成查询向量 → Repository.searchHalfvec → 按 threshold 过滤映射', async () => {
      mockEmbedTexts.mockResolvedValue([[0.9, 0.8]]);
      mockRepo.searchHalfvec.mockResolvedValue([
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
      // Repository.searchHalfvec 收到正确入参
      expect(mockRepo.searchHalfvec).toHaveBeenCalledWith('p1', [0.9, 0.8], 5);
      // 只保留 score >= 0.7 的结果
      expect(result).toEqual([{ chunkId: 'c1', documentId: 'd1', content: '片段一', score: 0.95 }]);
    });

    it('检索结果为空应返回空数组（不抛异常）', async () => {
      mockEmbedTexts.mockResolvedValue([[0.1]]);
      mockRepo.searchHalfvec.mockResolvedValue([]);

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
    it('应委托 Repository.listByProject 返回文档列表', async () => {
      const now = '2026-01-01T00:00:00.000Z';
      mockRepo.listByProject.mockResolvedValue([
        sampleRagDocument('d1', {
          title: '设定集',
          mimeType: 'text/plain',
          chunksCount: 3,
          createdAt: now,
        }),
      ]);

      const result = await listRagDocuments('p1');

      expect(mockRepo.listByProject).toHaveBeenCalledWith('p1');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'd1',
        title: '设定集',
        chunksCount: 3,
        createdAt: now,
      });
    });
  });

  describe('deleteRagDocument', () => {
    it('应委托 Repository.deleteDocument 删除文档（DB 级联删除 chunks）', async () => {
      mockRepo.deleteDocument.mockResolvedValue(true);

      const result = await deleteRagDocument('d1');

      expect(mockRepo.deleteDocument).toHaveBeenCalledWith('d1');
      expect(result).toEqual({ id: 'd1' });
    });

    it('Repository 返回 false（文档不存在）应抛 NOT_FOUND', async () => {
      mockRepo.deleteDocument.mockResolvedValue(false);

      await expect(deleteRagDocument('nope')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });
});
