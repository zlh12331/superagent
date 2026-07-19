// src/main/ipc/handlers/rag.handler.ts
// RAG 域 IPC handler（薄层）
// 设计文档 §4.1 分层架构：handler 只做参数校验 + 调 service
// §6.4 HNSW 索引 / §6.2 RagDocument / RagDocumentChunk 模型
//
// 职责：
// 1. 注册 rag 域 4 个 channel（ingestDocument/search/listDocuments/deleteDocument）
// 2. 通过 wrap() 统一包装：sender 校验 + traceId + zod 校验 + 错误处理
// 3. ingestDocument/search 透传 input（schema 已校验）
// 4. listDocuments/deleteDocument 使用内联 schema
//
// 注意：
// - handler 不持有状态，不直接访问 Prisma / pgvector
// - embedding 向量只在 service 内部流转，不跨 IPC 传输
// - listDocuments 从 input 提取 projectId

import {
  IPC_CHANNELS,
  RagIngestDocumentInputSchema,
  RagSearchInputSchema,
} from '@novel-writer/shared';
import { z } from 'zod';
import {
  deleteRagDocument,
  ingestDocument,
  listRagDocuments,
  searchSimilarChunks,
} from '../../services/rag.service';
import { wrap } from '../../utils/wrap';

/**
 * 注册 rag 域 IPC handler
 *
 * 注册 4 个 channel：
 * - rag:ingestDocument → ingestDocument
 * - rag:search         → searchSimilarChunks
 * - rag:listDocuments  → listRagDocuments
 * - rag:deleteDocument → deleteRagDocument
 */
export function registerRagHandlers(): void {
  // 文档入库：透传 input（RagIngestDocumentInputSchema 已校验）
  wrap(IPC_CHANNELS.RAG_INGEST_DOCUMENT, RagIngestDocumentInputSchema, (input) =>
    ingestDocument(input),
  );

  // 相似检索：透传 input（RagSearchInputSchema 已校验，topK/threshold 有默认值）
  wrap(IPC_CHANNELS.RAG_SEARCH, RagSearchInputSchema, (input) => searchSimilarChunks(input));

  // 列出项目下 RAG 文档：从 input 提取 projectId
  wrap(IPC_CHANNELS.RAG_LIST_DOCUMENTS, z.object({ projectId: z.string().min(1) }), (input) =>
    listRagDocuments(input.projectId),
  );

  // 删除 RAG 文档（DB 层级联删除 chunks）：从 input 提取 id
  wrap(IPC_CHANNELS.RAG_DELETE_DOCUMENT, z.object({ id: z.string().min(1) }), (input) =>
    deleteRagDocument(input.id),
  );
}
