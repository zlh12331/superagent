// src/main/services/rag.service.ts
// RAG 业务逻辑层
// 设计文档 §4.2 rag.service / §6.2 RagDocument / RagDocumentChunk 模型 / §6.4 HNSW 索引
//
// 职责：
// 1. 文档切片（按段落 + 最大长度硬切）
// 2. 向量入库（embedding 是 Unsupported("halfvec(2048)")，必须 raw SQL 写入）
// 3. 相似检索（pgvector 余弦距离 <=>）
// 4. 文档管理（list / delete）
// 5. PDF 文档解析（mimeType === 'application/pdf' 时先走 pdf-parser，再切片）
//
// 注意：
// - 向量只在主进程内流转，不跨 IPC、不出现在返回值中
// - 调用 embedding.service 生成向量（设计文档 §4.2 允许 rag.service 依赖 embedding.service）
// - 表名 snake_case（rag_document_chunks），列名 camelCase（"documentId"），raw SQL 需注意双引号
// - PDF 文件由渲染层以 base64 字符串形式通过 fileContent 字段传入（避免修改 IPC schema）
//   主进程解码 base64 → Uint8Array → 调 parsePdfToText → 得到的 text 替换 fileContent，后续流程不变

import {
  AppError,
  ErrorCode,
  type RagDocument,
  type RagIngestDocumentInput,
  type RagSearchInput,
  type RagSearchResultItem,
} from '@novel-writer/shared';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../infra/prisma/client';
import { parsePdfToText } from '../infra/rag/pdf-parser';
import { logger } from '../utils/logger';
import { embedTexts } from './embedding.service';

/** 单 chunk 最大字符数（中文按字符计，约 400 token） */
const MAX_CHUNK_SIZE = 800;

/** 入库文档最大字符数（防止超大文档撑爆嵌入与 DB） */
const MAX_DOCUMENT_SIZE = 200_000;

/**
 * 文档入库
 *
 * 流程：
 * 1. 若 mimeType === 'application/pdf'：fileContent 视为 base64 字符串
 *    → Buffer.from(base64, 'base64') → parsePdfToText → 得到纯文本
 * 2. 文本大小校验（基于解析后的文本字符数，PDF 与文本统一标准）
 * 3. 切片 → 批量嵌入 → 建文档记录 → 逐 chunk raw SQL 插入 → 更新 chunksCount
 *
 * @throws AppError(RAG_DOCUMENT_TOO_LARGE) 文档超过 200_000 字符（解析后）
 * @throws AppError(RAG_DOCUMENT_PARSE_FAILED) PDF 解析失败（文件损坏 / 加密 / 不支持）
 * @throws AppError(RAG_EMBEDDING_FAILED) 嵌入失败（由 embedding.service 抛出）
 */
export async function ingestDocument(
  input: RagIngestDocumentInput,
): Promise<{ documentId: string; chunksCount: number }> {
  const prisma = getPrismaClient();
  logger.info(
    { projectId: input.projectId, title: input.title, size: input.fileContent.length },
    '文档入库',
  );

  // 1. 解析原始文本（PDF 需先解码 base64 → 解析为文本）
  // PDF：fileContent 是渲染层用 FileReader.readAsDataURL 得到的 base64 字符串
  // 文本：fileContent 即为原始文本，无需转换
  const content =
    input.mimeType === 'application/pdf'
      ? await parsePdfToText(new Uint8Array(Buffer.from(input.fileContent, 'base64')))
      : input.fileContent;

  // 2. 大小校验（基于解析后的文本字符数，PDF 与文本统一标准）
  if (content.length > MAX_DOCUMENT_SIZE) {
    throw new AppError(
      ErrorCode.RAG_DOCUMENT_TOO_LARGE,
      `文档过大（${content.length} 字符，上限 ${MAX_DOCUMENT_SIZE}）`,
    );
  }

  // 3. 切片
  const chunks = chunkText(content);

  // 4. 创建文档记录（先建记录拿到 documentId，再插 chunks）
  const document = await prisma.ragDocument.create({
    data: {
      projectId: input.projectId,
      title: input.title,
      mimeType: input.mimeType ?? null,
      source: null,
      metadata: {},
    },
  });

  // 5. 无有效切片：直接返回空文档
  if (chunks.length === 0) {
    logger.warn({ documentId: document.id }, '文档切片后无有效内容');
    return { documentId: document.id, chunksCount: 0 };
  }

  // 6. 批量嵌入
  const vectors = await embedTexts(chunks);

  // 7. 逐 chunk raw SQL 插入（embedding 字段 Prisma Client 不支持，必须 raw SQL）
  for (const [index, chunkContent] of chunks.entries()) {
    const vector = vectors[index];
    if (vector === undefined) {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        `嵌入向量数量与切片数量不一致（index=${index}）`,
      );
    }
    const vectorLiteral = `[${vector.join(',')}]`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO rag_document_chunks (id, "documentId", content, "chunkIndex", embedding, metadata, "createdAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4::halfvec, '{}', NOW())`,
      document.id,
      chunkContent,
      index,
      vectorLiteral,
    );
  }

  // 8. 更新 chunksCount
  await prisma.ragDocument.update({
    where: { id: document.id },
    data: { chunksCount: chunks.length },
  });

  logger.info({ documentId: document.id, chunksCount: chunks.length }, '文档入库完成');
  return { documentId: document.id, chunksCount: chunks.length };
}

/**
 * 相似检索
 *
 * 流程：查询向量化 → 余弦距离检索（全表按 projectId JOIN 过滤）→ JS 侧 threshold 过滤
 *
 * 注意：空结果返回 []，不抛 RAG_NO_RESULTS（检索不到是正常业务情况，非错误）
 *
 * @throws AppError(RAG_EMBEDDING_FAILED) 查询向量化失败（由 embedding.service 抛出）
 * @throws AppError(INTERNAL_ERROR) 嵌入返回空向量数组
 */
export async function searchSimilarChunks(input: RagSearchInput): Promise<RagSearchResultItem[]> {
  const prisma = getPrismaClient();
  logger.debug(
    { projectId: input.projectId, query: input.query, topK: input.topK },
    'RAG 相似检索',
  );

  // 1. 查询向量化
  const vectors = await embedTexts([input.query]);
  const queryVector = vectors[0];
  if (queryVector === undefined) {
    throw new AppError(ErrorCode.INTERNAL_ERROR, '嵌入服务返回空向量数组');
  }
  const vectorLiteral = `[${queryVector.join(',')}]`;

  // 2. 余弦距离检索（<=> 返回距离，1 - 距离 = 相似度 score）
  const rows = await prisma.$queryRawUnsafe<
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
    input.projectId,
    input.topK,
  );

  // 3. threshold 过滤 + 映射
  return rows
    .filter((row) => row.score >= input.threshold)
    .map((row) => ({
      chunkId: row.chunkId,
      documentId: row.documentId,
      content: row.content,
      score: row.score,
    }));
}

/**
 * 列出项目下所有 RAG 文档（按 createdAt 倒序）
 */
export async function listRagDocuments(projectId: string): Promise<RagDocument[]> {
  const prisma = getPrismaClient();
  const documents = await prisma.ragDocument.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  });
  return documents.map(serializeRagDocument);
}

/**
 * 删除 RAG 文档
 *
 * DB 层 onDelete: Cascade 自动级联删除所有 chunks
 *
 * @throws AppError(NOT_FOUND) 文档不存在
 */
export async function deleteRagDocument(id: string): Promise<{ id: string }> {
  const prisma = getPrismaClient();

  const existing = await prisma.ragDocument.findUnique({ where: { id } });
  if (existing === null) {
    throw new AppError(ErrorCode.NOT_FOUND, `RAG 文档不存在：${id}`);
  }

  await prisma.ragDocument.delete({ where: { id } });
  logger.info({ documentId: id }, '删除 RAG 文档（含 chunks 级联）');
  return { id };
}

/**
 * 文本切片
 *
 * 规则：
 * 1. 按空行分段（/\n{2,}/）
 * 2. 顺序累加段落，单 chunk 不超 MAX_CHUNK_SIZE；超过则截断当前 chunk，开新 chunk
 * 3. 单段落超 MAX_CHUNK_SIZE 时硬切为多个连续 chunk
 * 4. 过滤纯空白段落
 *
 * @returns 切片数组（可能为空）
 */
function chunkText(text: string): string[] {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    // 单段落超限：先 flush 当前 chunk，再对段落硬切
    if (paragraph.length > MAX_CHUNK_SIZE) {
      if (current.length > 0) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < paragraph.length; i += MAX_CHUNK_SIZE) {
        chunks.push(paragraph.slice(i, i + MAX_CHUNK_SIZE));
      }
      continue;
    }

    // 累加超限：flush 当前 chunk，段落作为新 chunk 起点
    if (current.length > 0 && current.length + 2 + paragraph.length > MAX_CHUNK_SIZE) {
      chunks.push(current);
      current = paragraph;
      continue;
    }

    // 正常累加（段落间保留空行分隔）
    current = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
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
