// packages/shared/src/schemas/rag.schema.ts
// RagDocument / RagDocumentChunk Zod schema
// 字段来源：设计文档 §6.2 Prisma RagDocument / RagDocumentChunk 模型
// 注意：embedding 向量不跨 IPC 传输，schema 中不含 embedding 字段

import { z } from 'zod';

/** RagDocument 实体 schema */
export const RagDocumentSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1).max(200),
  source: z.string().max(500).nullable().optional(),
  mimeType: z.string().max(100).nullable().optional(),
  chunksCount: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().min(1),
});
export type RagDocument = z.infer<typeof RagDocumentSchema>;

/** 文档入库入参 */
export const RagIngestDocumentInputSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1).max(200),
  fileContent: z.string().min(1),
  mimeType: z.string().max(100).optional(),
});
export type RagIngestDocumentInput = z.infer<typeof RagIngestDocumentInputSchema>;

/** 相似检索入参 */
export const RagSearchInputSchema = z.object({
  projectId: z.string().min(1),
  query: z.string().min(1),
  topK: z.number().int().positive().max(50).default(5),
  threshold: z.number().min(0).max(1).default(0.7),
});
export type RagSearchInput = z.infer<typeof RagSearchInputSchema>;

/** 检索结果项 */
export const RagSearchResultItemSchema = z.object({
  chunkId: z.string().min(1),
  documentId: z.string().min(1),
  content: z.string(),
  score: z.number().min(0).max(1),
});
export type RagSearchResultItem = z.infer<typeof RagSearchResultItemSchema>;
