// tests/integration/helpers/reset-db.ts
// 集成测试数据清理工具
// 设计文档 §8.3 集成测试策略 / Phase 9 plan Task 3
//
// 职责：
// 提供 resetDatabase() 在每个测试用例 beforeEach 调用，清空所有业务表数据
// 保证测试用例隔离（避免上一次测试残留影响下一次）
//
// 设计要点：
// 1. 使用 TRUNCATE TABLE ... RESTART IDENTITY CASCADE
//    - RESTART IDENTITY：重置自增序列（gen_random_uuid 不受影响，但 SERIAL 列会重置）
//    - CASCADE：级联清空所有外键关联表
// 2. 表清单按外键依赖倒序排列（从依赖最多的表开始）
//    - 实际上 CASCADE 会自动处理依赖，但显式倒序更清晰
// 3. 不删除扩展、表结构、索引（仅清数据）
// 4. 不重置 HNSW 索引状态（resetHnswIndexState 在 setup.ts 启动时调用一次即可）
//
// 注意：
// - 调用前需确保容器已启动（通过 setup.ts 的 beforeAll）
// - TRUNCATE 是 DDL 操作，会隐式提交事务，无法回滚
// - 测试用例内若需要事务回滚隔离，应使用 prisma.$transaction 包裹
//   但本项目集成测试场景简单，TRUNCATE 即可

import { getTestPrismaClient } from './pg-container';

/**
 * 业务表清单（按外键依赖倒序排列）
 *
 * 倒序逻辑：被引用的表在最后，引用其他表的表在前
 * - ai_usage_logs / app_settings：无外键依赖，先清空
 * - rag_document_chunks：FK → rag_documents
 * - rag_documents：FK → projects
 * - chat_messages：FK → chat_sessions
 * - chat_sessions：FK → projects
 * - project_settings：FK → projects
 * - worldviews：FK 自引用 + projects
 * - characters：FK → projects
 * - chapters：FK → projects + volumes
 * - volumes：FK → projects
 * - projects：被多个表引用，最后清空
 *
 * 注意：TRUNCATE CASCADE 会自动级联，倒序仅为可读性
 */
const TABLES_TO_TRUNCATE = [
  'ai_usage_logs',
  'app_settings',
  'rag_document_chunks',
  'rag_documents',
  'chat_messages',
  'chat_sessions',
  'project_settings',
  'worldviews',
  'characters',
  'chapters',
  'volumes',
  'projects',
] as const;

/**
 * 重置数据库：TRUNCATE 所有业务表
 *
 * 在每个测试用例 beforeEach 调用，保证用例隔离
 *
 * @throws Error 容器未启动 / TRUNCATE 执行失败
 */
export async function resetDatabase(): Promise<void> {
  const prisma = getTestPrismaClient();

  // 单条 TRUNCATE 即可（CASCADE 会级联清空所有外键关联表）
  // 但显式列出所有表更清晰，且避免遗漏无外键的表（如 ai_usage_logs / app_settings）
  const tableList = TABLES_TO_TRUNCATE.join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE;`);
}
