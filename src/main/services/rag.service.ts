// src/main/services/rag.service.ts
// RAG 业务逻辑层
// 设计文档 §4.2 rag.service / §6.2 RagDocument / RagDocumentChunk 模型 / §6.4 HNSW 索引
//
// 职责：
// 1. 文档切片（按段落 + 最大长度硬切）
// 2. PDF 文档解析（mimeType === 'application/pdf' 时先走 pdf-parser，再切片）
// 3. 向量入库编排（嵌入 + 委托 Repository 写入）
// 4. 相似检索编排（嵌入 + 委托 Repository 检索 + JS 侧 threshold 过滤）
// 5. 文档管理（list / delete，委托 Repository）
//
// 架构原则（设计文档 §4.3 Repository 模式）：
// - service 层只依赖 Repository，不直接调用 PrismaClient / raw SQL
// - SQL/halfvec 细节封装在 Repository 内
// - 事务原子性由 Repository 保证（insertChunksBatch 内部 $transaction）
// - service 关注切片、嵌入、解析等业务逻辑
//
// 注意：
// - 向量只在主进程内流转，不跨 IPC、不出现在返回值中
// - 调用 embedding.service 生成向量（设计文档 §4.2 允许 rag.service 依赖 embedding.service）
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
import { getPrismaClient } from '../infra/prisma/client';
import { parsePdfToText } from '../infra/rag/pdf-parser';
import { RagRepository } from '../infra/repositories/rag.repository';
import { logger } from '../utils/logger';
import { embedTexts } from './embedding.service';

/** 单 chunk 最大字符数（中文按字符计，约 400 token） */
const MAX_CHUNK_SIZE = 800;

/** 入库文档最大字符数（防止超大文档撑爆嵌入与 DB） */
const MAX_DOCUMENT_SIZE = 200_000;

/**
 * 获取 RAG 领域 Repository 实例
 *
 * 每次调用创建新实例：Repository 无状态，新实例避免潜在的状态泄漏
 */
function getRagRepository(): RagRepository {
  return new RagRepository(getPrismaClient());
}

/**
 * 文档入库
 *
 * 流程：
 * 1. 若 mimeType === 'application/pdf'：fileContent 视为 base64 字符串
 *    → Buffer.from(base64, 'base64') → parsePdfToText → 得到纯文本
 * 2. 文本大小校验（基于解析后的文本字符数，PDF 与文本统一标准）
 * 3. 切片 → 批量嵌入 → 建文档记录 → 委托 Repository 批量插入 chunks + 更新 chunksCount（事务原子性）
 *
 * @throws AppError(RAG_DOCUMENT_TOO_LARGE) 文档超过 200_000 字符（解析后）
 * @throws AppError(RAG_DOCUMENT_PARSE_FAILED) PDF 解析失败（文件损坏 / 加密 / 不支持）
 * @throws AppError(RAG_EMBEDDING_FAILED) 嵌入失败（由 embedding.service 抛出）
 * @throws AppError(INTERNAL_ERROR) 嵌入向量数量与切片数量不一致
 */
export async function ingestDocument(
  input: RagIngestDocumentInput,
): Promise<{ documentId: string; chunksCount: number }> {
  logger.info(
    { projectId: input.projectId, title: input.title, size: input.fileContent.length },
    '文档入库',
  );

  const repo = getRagRepository();

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
  const document = await repo.createDocument({
    projectId: input.projectId,
    title: input.title,
    mimeType: input.mimeType,
  });

  // 5. 无有效切片：直接返回空文档（chunksCount 默认 0 由 createDocument 设置）
  if (chunks.length === 0) {
    logger.warn({ documentId: document.id }, '文档切片后无有效内容');
    return { documentId: document.id, chunksCount: 0 };
  }

  // 6. 批量嵌入
  const vectors = await embedTexts(chunks);

  // 7. 嵌入向量数量校验（防止 embedding.service 返回数量不一致）
  if (vectors.length !== chunks.length) {
    throw new AppError(
      ErrorCode.INTERNAL_ERROR,
      `嵌入向量数量(${vectors.length})与切片数量(${chunks.length})不一致`,
    );
  }

  // 8. 委托 Repository 批量插入 chunks + 更新 chunksCount（事务原子性，任一失败回滚）
  // noUncheckedIndexedAccess 下 vectors[index] 类型为 number[] | undefined，
  // 前面已校验 vectors.length === chunks.length，此处用 as 断言安全（避免 ! 非空断言）
  await repo.insertChunksBatch(
    document.id,
    chunks.map((content, index) => ({
      content,
      index,
      vector: vectors[index] as number[],
    })),
  );

  logger.info({ documentId: document.id, chunksCount: chunks.length }, '文档入库完成');
  return { documentId: document.id, chunksCount: chunks.length };
}

/**
 * 相似检索
 *
 * 流程：查询向量化 → Repository 余弦距离检索 → JS 侧 threshold 过滤
 *
 * 注意：空结果返回 []，不抛 RAG_NO_RESULTS（检索不到是正常业务情况，非错误）
 *
 * @throws AppError(RAG_EMBEDDING_FAILED) 查询向量化失败（由 embedding.service 抛出）
 * @throws AppError(INTERNAL_ERROR) 嵌入返回空向量数组
 */
export async function searchSimilarChunks(input: RagSearchInput): Promise<RagSearchResultItem[]> {
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

  // 2. 委托 Repository 检索（HNSW 余弦距离 + JOIN rag_documents 过滤 projectId）
  const rows = await getRagRepository().searchHalfvec(input.projectId, queryVector, input.topK);

  // 3. threshold 过滤 + 映射（Repository 返回全量 topK，由 service 按 threshold 过滤）
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
  return getRagRepository().listByProject(projectId);
}

/**
 * 删除 RAG 文档
 *
 * DB 层 onDelete: Cascade 自动级联删除所有 chunks（由 Repository 委托 Prisma delete）
 *
 * @throws AppError(NOT_FOUND) 文档不存在
 */
export async function deleteRagDocument(id: string): Promise<{ id: string }> {
  const deleted = await getRagRepository().deleteDocument(id);
  if (!deleted) {
    throw new AppError(ErrorCode.NOT_FOUND, `RAG 文档不存在：${id}`);
  }
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
