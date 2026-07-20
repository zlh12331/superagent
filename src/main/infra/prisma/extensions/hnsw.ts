// src/main/infra/prisma/extensions/hnsw.ts
// HNSW 向量索引 + pg_trgm 全文索引初始化（设计文档 §6.4）
//
// 职责：
// 1. CREATE EXTENSION pgvector（已由 migration.sql 幂等创建，此处不重复）
// 2. CREATE EXTENSION pg_trgm（章节内容 GIN 索引）
// 3. 创建 HNSW 索引（halfvec(2048) + m=16 + ef_construction=64）
// 4. 创建章节内容 trgm 索引（相似度搜索）
// 5. 创建章节复合索引（project_id + sort_order）
//
// 注意：
// - HNSW 索引在 migration 之后创建（Prisma 不支持 halfvec 类型 DDL）
// - 索引创建幂等（IF NOT EXISTS）
// - 大表创建 HNSW 索引可能耗时，生产环境应在用户引导下执行
// - pg_trgm GIN 索引失败仅 warn 不阻塞（可能因 AGE_INIT_SQL 改变 search_path
//   导致 gin_trgm_ops opclass 不可见；相似度搜索功能不可用，但其他功能正常）

import type { PrismaClient } from '@prisma/client';
import { logger } from '../../../utils/logger';

/**
 * 创建 pg_trgm 扩展（章节内容相似度搜索）
 */
const CREATE_PG_TRGM_SQL = 'CREATE EXTENSION IF NOT EXISTS pg_trgm;';

/**
 * HNSW 索引 SQL（设计文档 §6.4）
 *
 * - halfvec(2048) + 余弦距离
 * - m=16（每个节点的最大连接数）
 * - ef_construction=64（构建时搜索宽度）
 */
const CREATE_HNSW_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_rag_chunks_embedding
    ON rag_document_chunks
    USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64);
`;

/**
 * 章节内容 GIN trgm 索引（相似度搜索）
 */
const CREATE_CONTENT_TRGM_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_chapters_content_trgm
    ON chapters USING gin (content gin_trgm_ops);
`;

/**
 * 章节复合索引（项目列表排序）
 *
 * 字段名与 Prisma migration 一致（camelCase，需双引号包裹避免 PG 解析为小写）
 */
const CREATE_CHAPTERS_PROJECT_ORDER_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_chapters_project_order
    ON chapters ("projectId", "sortOrder");
`;

/**
 * 索引初始化状态
 *
 * 避免每次应用启动都执行 CREATE INDEX（IF NOT EXISTS 仍会有 SQL 往返）
 */
let isInitialized = false;

/**
 * 初始化所有索引
 *
 * 顺序：
 * 1. pg_trgm 扩展
 * 2. HNSW 向量索引（pgvector 未安装时跳过，不阻塞应用启动）
 * 3. trgm 全文索引
 * 4. 章节复合索引
 *
 * 容错策略：
 * - pgvector 未安装时 HNSW 索引创建失败 → 跳过，仅 warn
 * - pg_trgm GIN 索引失败 → 跳过，仅 warn（不阻塞应用启动）
 *   可能因 AGE_INIT_SQL 改变 search_path 导致 gin_trgm_ops opclass 不可见
 * - 章节复合索引失败 → 抛错（核心功能）
 * - RAG 检索 / 相似度搜索功能不可用时不阻塞应用启动
 *
 * @throws Error 核心索引创建失败（章节复合索引）
 */
export async function ensureHnswIndex(client: PrismaClient): Promise<void> {
  if (isInitialized) {
    logger.debug({}, 'HNSW 索引已初始化，跳过');
    return;
  }

  logger.info({}, '初始化向量索引与全文索引');

  await client.$executeRawUnsafe(CREATE_PG_TRGM_SQL);
  logger.info({}, 'pg_trgm 扩展已就绪');

  // HNSW 向量索引依赖 pgvector 扩展（便携版 PG 默认不含，需单独安装）
  // 失败时跳过，仅 warn 不阻塞应用启动（RAG 检索功能不可用，但其他功能正常）
  try {
    await client.$executeRawUnsafe(CREATE_HNSW_INDEX_SQL);
    logger.info({}, 'HNSW 向量索引已就绪（halfvec(2048), m=16, ef_construction=64）');
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'HNSW 向量索引创建失败（pgvector 扩展可能未安装），跳过；RAG 检索功能不可用',
    );
  }

  // 章节内容 trgm GIN 索引（相似度搜索）
  // 失败时跳过，仅 warn 不阻塞应用启动
  // 可能因 AGE_INIT_SQL 改变 search_path 导致 gin_trgm_ops opclass 不可见
  try {
    await client.$executeRawUnsafe(CREATE_CONTENT_TRGM_INDEX_SQL);
    logger.info({}, 'chapters.content trgm 索引已就绪');
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'chapters.content trgm 索引创建失败（gin_trgm_ops opclass 可能因 search_path 不可见），跳过；相似度搜索功能不可用',
    );
  }

  await client.$executeRawUnsafe(CREATE_CHAPTERS_PROJECT_ORDER_INDEX_SQL);
  logger.info({}, 'chapters(project_id, sort_order) 复合索引已就绪');

  isInitialized = true;
  logger.info({}, '索引初始化完成');
}

/**
 * 重置初始化状态（仅测试用）
 */
export function resetHnswIndexState(): void {
  isInitialized = false;
}
