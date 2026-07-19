// tests/integration/rag.service.integration.test.ts
// rag.service 集成测试：真实 PG + pgvector HNSW 索引 + 级联删除验证
// Phase 9 plan Task 4 / 设计文档 §8.3 集成测试策略
//
// 测试场景（覆盖 RAG 全链路）：
// 1. 入库 .md 文档（mock embedding.service 返回固定向量）→ 验证 chunksCount > 0
// 2. 检索相同查询向量（mock 返回入库时的同向量）→ 验证 score = 1.0（余弦距离 = 0）
// 3. 检索不同查询向量 → 验证 score < 1.0
// 4. 删除文档 → 验证 chunks 被级联删除（onDelete: Cascade）
// 5. 列出文档 → 验证返回顺序与字段
//
// mock 策略：
// - mock embedding.service.embedTexts，返回 2048 维单位向量（向量的余弦相似度计算可预测）
// - 入库时 mock 返回 N 个相同向量（N = chunks 数量）
// - 检索时 mock 返回 1 个向量，可通过控制向量值验证 score
//   - 返回与入库相同的向量 → score = 1.0
//   - 返回与入库正交的向量 → score = 0.0
//
// 注意：
// - 集成测试不依赖真实 Ollama，通过 vi.mock 隔离
// - vi.mock 提升到模块顶部，必须用 vi.hoisted 传递状态
// - mock 内部通过变量控制返回值（同向量 / 正交向量），便于不同用例切换
// - 即使 mock 了 embedding.service，logAiUsage 不会被调用（在 embedding.service 内部），
//   ai_usage_logs 表不会有 RAG 相关记录，这是预期的（用量日志由 embedding.service 内部负责）

import { AppError, ErrorCode } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestPrismaClient, isContainerReady } from './helpers/pg-container';
import { resetDatabase } from './helpers/reset-db';

/**
 * mock 状态：控制 embedTexts 返回的向量
 *
 * - mode: 'same' 返回入库时的同向量（score = 1.0）
 * - mode: 'orthogonal' 返回与入库向量正交的向量（score = 0.0）
 *
 * 使用 vi.hoisted 确保 mock factory 能访问到这个变量
 */
const { mockEmbed, mockState } = vi.hoisted(() => {
  /** 2048 维单位向量（所有分量 = 1/sqrt(2048)，模为 1） */
  const unitVector = Array.from({ length: 2048 }, () => 1 / Math.sqrt(2048));

  /**
   * 2048 维正交向量（与 unitVector 正交）
   *
   * 构造方法：前一半分量 = 1/sqrt(2048)，后一半分量 = -1/sqrt(2048)
   * 与 unitVector（全 1/sqrt(2048)）的点积 = 1024*(1/2048) - 1024*(1/2048) = 0
   */
  const orthogonalVector = Array.from({ length: 2048 }, (_, i) =>
    i < 1024 ? 1 / Math.sqrt(2048) : -1 / Math.sqrt(2048),
  );

  /** 当前模式：'same' = 返回 unitVector，'orthogonal' = 返回 orthogonalVector */
  const mockState = { mode: 'same' as 'same' | 'orthogonal' };

  /** mock 的 embedTexts 实现：根据 mode 返回对应向量 */
  const mockEmbed = vi.fn(async (texts: string[]) => {
    return texts.map(() => (mockState.mode === 'same' ? unitVector : orthogonalVector));
  });

  return { mockEmbed, mockState };
});

// mock embedding.service 模块（rag.service 内部 import './embedding.service'）
// 注意：vi.mock 路径相对于测试文件，指向 embedding.service 实际位置
vi.mock('../../src/main/services/embedding.service', () => ({
  embedTexts: mockEmbed,
}));

// mock pdf-parser 模块（rag.service 内部 import '../infra/rag/pdf-parser'）
// 集成测试不测试 PDF 解析（由 Task 2 单测覆盖），mock 为抛错避免误调用
vi.mock('../../src/main/infra/rag/pdf-parser', () => ({
  parsePdfToText: vi.fn().mockRejectedValue(new Error('集成测试不支持 PDF 解析')),
}));

describe.skipIf(!isContainerReady())('rag.service 集成测试', () => {
  let prisma: ReturnType<typeof getTestPrismaClient>;

  beforeEach(async () => {
    prisma = getTestPrismaClient();
    await resetDatabase();
    // 重置 mock 状态与调用记录
    mockState.mode = 'same';
    mockEmbed.mockClear();
  });

  /**
   * 创建测试用 project（ragDocument.create 需要 projectId 外键）
   *
   * @returns 创建好的 project ID
   */
  async function createTestProject(id: string): Promise<string> {
    await prisma.project.create({
      data: {
        id,
        name: `RAG 测试项目-${id}`,
        status: 'ACTIVE',
        metadata: {},
        updatedAt: new Date(),
      },
    });
    return id;
  }

  it('入库 .md 文档 → 验证 chunksCount > 0 且 chunks 已写入', async () => {
    const { ingestDocument, listRagDocuments } = await import(
      '../../src/main/services/rag.service'
    );

    await createTestProject('rag-it-1');

    // 构造一个会被切成多个 chunk 的文档（按空行分段）
    const longContent = [
      '# 第一章 简介',
      '',
      '这是第一段内容，描述了世界观的设定。包含魔法体系与种族关系。',
      '',
      '# 第二章 人物',
      '',
      '主角是一个年轻的法师，名叫艾伦。他出身平凡，却拥有罕见的天赋。',
    ].join('\n');

    // 入库（mock embedding.service 返回固定向量）
    const result = await ingestDocument({
      projectId: 'rag-it-1',
      title: '测试文档.md',
      fileContent: longContent,
      mimeType: 'text/markdown',
    });

    // 验证返回的 documentId 与 chunksCount
    expect(result.documentId).toBeTruthy();
    expect(result.chunksCount).toBeGreaterThan(0);

    // 验证 rag_documents 表记录
    const documents = await listRagDocuments('rag-it-1');
    expect(documents.length).toBe(1);
    expect(documents[0]?.title).toBe('测试文档.md');
    expect(documents[0]?.chunksCount).toBe(result.chunksCount);
    expect(documents[0]?.mimeType).toBe('text/markdown');

    // 验证 rag_document_chunks 表记录
    const dbChunks = await prisma.ragDocumentChunk.count({
      where: { documentId: result.documentId },
    });
    expect(dbChunks).toBe(result.chunksCount);

    // 验证 embedding 字段已写入（查询 halfvec 文本表示）
    const sample = await prisma.$queryRawUnsafe<{ embedding: string }[]>(
      `SELECT embedding::text FROM rag_document_chunks WHERE "documentId" = $1 LIMIT 1;`,
      result.documentId,
    );
    expect(sample.length).toBe(1);
    // halfvec 文本表示以 '[' 开头
    expect(sample[0]?.embedding).toMatch(/^\[/);

    // 验证 mock embedTexts 被调用（入库时调用一次，传入 chunks 数组）
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });

  it('检索相同查询向量 → score = 1.0（余弦距离 = 0）', async () => {
    const { ingestDocument, searchSimilarChunks } = await import(
      '../../src/main/services/rag.service'
    );

    await createTestProject('rag-it-2');

    // 入库文档（mock 返回 unitVector）
    const content = '这是一段用于检索测试的文档内容，包含若干关键词如 魔法、剑、龙。';
    await ingestDocument({
      projectId: 'rag-it-2',
      title: '检索测试文档',
      fileContent: content,
    });

    // 检索（mock 返回相同的 unitVector，score 应 = 1.0）
    mockState.mode = 'same';
    mockEmbed.mockClear();

    const results = await searchSimilarChunks({
      projectId: 'rag-it-2',
      query: '魔法 剑 龙',
      topK: 5,
      threshold: 0.5, // 降低 threshold 确保 score=1.0 的结果被保留
    });

    // 验证返回结果非空
    expect(results.length).toBeGreaterThan(0);

    // 验证最高 score 接近 1.0（余弦距离 = 0，相似度 = 1）
    // halfvec 是 float16，可能有精度损失，允许 0.001 误差
    const maxScore = Math.max(...results.map((r) => r.score));
    expect(maxScore).toBeGreaterThan(0.999);

    // 验证返回的 chunk 内容是入库的文档内容
    expect(results[0]?.content).toContain('魔法');

    // 验证 mock 在检索时被调用一次（传入查询文本）
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });

  it('检索正交查询向量 → score 接近 0.0', async () => {
    const { ingestDocument, searchSimilarChunks } = await import(
      '../../src/main/services/rag.service'
    );

    await createTestProject('rag-it-3');

    // 入库文档（mock 返回 unitVector）
    await ingestDocument({
      projectId: 'rag-it-3',
      title: '正交测试文档',
      fileContent: '入库向量与查询向量正交，期望 score 接近 0。',
    });

    // 检索（mock 返回 orthogonalVector，与入库 unitVector 正交，score 应 ≈ 0）
    mockState.mode = 'orthogonal';
    mockEmbed.mockClear();

    const results = await searchSimilarChunks({
      projectId: 'rag-it-3',
      query: '完全不同的查询',
      topK: 5,
      threshold: 0, // threshold = 0 保留所有结果，便于验证 score
    });

    // 验证返回结果非空（threshold=0 不会过滤掉正交结果）
    expect(results.length).toBeGreaterThan(0);

    // 验证 score 接近 0（正交向量的余弦相似度 = 0）
    // halfvec float16 精度损失，允许 0.05 误差
    const maxScore = Math.max(...results.map((r) => r.score));
    expect(maxScore).toBeLessThan(0.05);
  });

  it('删除文档 → 验证 chunks 被级联删除', async () => {
    const { ingestDocument, deleteRagDocument, listRagDocuments } = await import(
      '../../src/main/services/rag.service'
    );

    await createTestProject('rag-it-4');

    // 入库文档
    const result = await ingestDocument({
      projectId: 'rag-it-4',
      title: '将被删除的文档',
      fileContent: '这是一段内容，用于验证删除级联。\n\n第二段内容。',
    });
    expect(result.chunksCount).toBeGreaterThan(0);

    // 验证文档与 chunks 已写入
    const beforeDocs = await listRagDocuments('rag-it-4');
    expect(beforeDocs.length).toBe(1);
    const beforeChunks = await prisma.ragDocumentChunk.count({
      where: { documentId: result.documentId },
    });
    expect(beforeChunks).toBe(result.chunksCount);

    // 删除文档
    const deleteResult = await deleteRagDocument(result.documentId);
    expect(deleteResult.id).toBe(result.documentId);

    // 验证文档已删除（列表为空）
    const afterDocs = await listRagDocuments('rag-it-4');
    expect(afterDocs.length).toBe(0);

    // 验证 chunks 被级联删除（rag_document_chunks 表中该文档的 chunks 全部消失）
    const afterChunks = await prisma.ragDocumentChunk.count({
      where: { documentId: result.documentId },
    });
    expect(afterChunks).toBe(0);
  });

  it('删除不存在的文档 → 抛 AppError(NOT_FOUND)', async () => {
    const { deleteRagDocument } = await import('../../src/main/services/rag.service');

    const nonExistentId = 'non-existent-doc-id-67890';

    await expect(deleteRagDocument(nonExistentId)).rejects.toThrow(AppError);
    await expect(deleteRagDocument(nonExistentId)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('删除 project → 验证 rag_documents 与 chunks 被级联删除', async () => {
    // 额外验证：删除 project 时，关联的 rag_documents 与 chunks 也被级联删除
    // Prisma schema: rag_documents.projectId onDelete: Cascade
    const { ingestDocument } = await import('../../src/main/services/rag.service');

    await createTestProject('rag-it-5');

    const result = await ingestDocument({
      projectId: 'rag-it-5',
      title: '随项目删除的文档',
      fileContent: '内容',
    });

    // 删除 project（直接 DB 操作）
    await prisma.project.delete({ where: { id: 'rag-it-5' } });

    // 验证 rag_documents 被级联删除
    const docCount = await prisma.ragDocument.count({
      where: { projectId: 'rag-it-5' },
    });
    expect(docCount).toBe(0);

    // 验证 rag_document_chunks 被级联删除（双重级联：project → doc → chunk）
    const chunkCount = await prisma.ragDocumentChunk.count({
      where: { documentId: result.documentId },
    });
    expect(chunkCount).toBe(0);
  });
});
