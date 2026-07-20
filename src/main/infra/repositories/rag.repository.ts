// src/main/infra/repositories/rag.repository.ts
// RAG 领域 Repository（设计文档 §4.3 infra 层 Repository 模式）
//
// 职责：
// 1. 封装 rag_documents / rag_document_chunks 表的 Prisma + raw SQL 操作
// 2. embedding 字段是 halfvec(2048)，Prisma Client 不支持，必须 raw SQL
// 3. 用 $transaction 保证批量插入 + chunksCount 更新的原子性
// 4. deleteDocument 依赖 DB ON DELETE CASCADE 自动级联清理 chunks
//
// 设计原则：
// - SQL/halfvec 细节封装在 Repository 内，service 层不感知
// - 失败时事务回滚，不留孤儿 chunks
//
// 注意：
// - 表名 snake_case（rag_document_chunks），列名 camelCase（"documentId"），raw SQL 需双引号
// - vector 字面量格式：'[0.1,0.2,0.3]'，由调用方传入 number[] 后用 join 拼接

import type { RagDocument } from '@novel-writer/shared';
import type { PrismaClient } from '@prisma/client';

/**
 * RAG 领域 Repository
 *
 * 封装 rag_documents / rag_document_chunks 表的所有数据库操作
 */
export class RagRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * 创建 RAG 文档记录（先建记录拿到 documentId，再插 chunks）
   *
   * @param input 入参（projectId / title 必填，mimeType 可选）
   * @returns 创建后的文档记录
   */
  async createDocument(input: {
    projectId: string;
    title: string;
    // service 层 RagIngestDocumentInput.mimeType 是 string | undefined（zod optional）
    // 接收 undefined 后内部用 ?? null 统一为 null 写入 DB
    mimeType?: string | undefined;
  }): Promise<RagDocument> {
    const document = await this.prisma.ragDocument.create({
      data: {
        projectId: input.projectId,
        title: input.title,
        mimeType: input.mimeType ?? null,
        source: null,
        metadata: {},
      },
    });
    return serializeRagDocument(document);
  }

  /**
   * 更新文档的 chunksCount（入库完成后调用）
   */
  async updateChunksCount(documentId: string, count: number): Promise<void> {
    await this.prisma.ragDocument.update({
      where: { id: documentId },
      data: { chunksCount: count },
    });
  }

  /**
   * 批量插入 chunks（事务原子性）
   *
   * 用 $transaction 包裹所有 chunk 插入 + chunksCount 更新
   * - 任一 chunk 插入失败 → 整个事务回滚，不留孤儿 chunks
   * - chunksCount 更新失败 → 也回滚所有 chunk 插入
   *
   * @param documentId 文档 ID
   * @param chunks chunks 数组（content + index + vector）
   */
  async insertChunksBatch(
    documentId: string,
    chunks: { content: string; index: number; vector: number[] }[],
  ): Promise<void> {
    if (chunks.length === 0) {
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      // 逐 chunk 插入（embedding 是 halfvec(2048)，Prisma 不支持，必须 raw SQL）
      for (const chunk of chunks) {
        const vectorLiteral = `[${chunk.vector.join(',')}]`;
        await tx.$executeRawUnsafe(
          `INSERT INTO rag_document_chunks (id, "documentId", content, "chunkIndex", embedding, metadata, "createdAt")
           VALUES (gen_random_uuid()::text, $1, $2, $3, $4::halfvec, '{}', NOW())`,
          documentId,
          chunk.content,
          chunk.index,
          vectorLiteral,
        );
      }

      // 更新 chunksCount（在事务内，避免与 chunks 不一致）
      await tx.ragDocument.update({
        where: { id: documentId },
        data: { chunksCount: chunks.length },
      });
    });
  }

  /**
   * 删除 RAG 文档（DB 层 ON DELETE CASCADE 自动级联删除所有 chunks）
   *
   * @returns true 删除成功；false 文档不存在
   */
  async deleteDocument(id: string): Promise<boolean> {
    const existing = await this.prisma.ragDocument.findUnique({ where: { id } });
    if (existing === null) {
      return false;
    }
    await this.prisma.ragDocument.delete({ where: { id } });
    return true;
  }

  /**
   * 按 ID 查找文档
   */
  async findById(id: string): Promise<RagDocument | null> {
    const found = await this.prisma.ragDocument.findUnique({ where: { id } });
    return found === null ? null : serializeRagDocument(found);
  }

  /**
   * 列出项目下所有 RAG 文档（按 createdAt 倒序）
   */
  async listByProject(projectId: string): Promise<RagDocument[]> {
    const documents = await this.prisma.ragDocument.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    return documents.map(serializeRagDocument);
  }

  /**
   * HNSW 余弦距离检索（pgvector）
   *
   * SQL：<=> 返回余弦距离，1 - 距离 = 相似度 score
   * JOIN rag_documents 用于按 projectId 过滤
   *
   * @param projectId 项目 ID（过滤范围）
   * @param vector 查询向量（2048 维）
   * @param topK 返回数量
   * @returns 检索结果（chunkId / documentId / content / score）
   */
  async searchHalfvec(
    projectId: string,
    vector: number[],
    topK: number,
  ): Promise<{ chunkId: string; documentId: string; content: string; score: number }[]> {
    const vectorLiteral = `[${vector.join(',')}]`;
    return this.prisma.$queryRawUnsafe<
      { chunkId: string; documentId: string; content: string; score: number }[]
    >(
      `SELECT c.id AS "chunkId", c."documentId", c.content,
              1 - (c.embedding <=> $1::halfvec) AS score
       FROM rag_document_chunks c
       JOIN rag_documents d ON d.id = c."documentId"
       WHERE d."projectId" = $2
       ORDER BY c.embedding <=> $1::halfvec
       LIMIT $3`,
      vectorLiteral,
      projectId,
      topK,
    );
  }
}

/**
 * 序列化 Prisma RagDocument 记录为 IPC 兼容的 RagDocument 类型
 */
function serializeRagDocument(raw: RawRagDocument): RagDocument {
  return {
    id: raw.id,
    projectId: raw.projectId,
    title: raw.title,
    source: raw.source,
    mimeType: raw.mimeType,
    chunksCount: raw.chunksCount,
    metadata: raw.metadata as Record<string, unknown>,
    createdAt: raw.createdAt.toISOString(),
  };
}

/** Prisma ragDocument.findUnique 返回的原始类型 */
type RawRagDocument = NonNullable<Awaited<ReturnType<PrismaClient['ragDocument']['findUnique']>>>;
