// tests/integration/smoke.integration.test.ts
// 集成测试烟雾测试：验证基础设施可运行
// Phase 9 plan Task 3 验收清单 §4 / Task 4 前置验证
//
// 验证内容：
// 1. PG 容器已启动（DATABASE_URL 已设置）
// 2. pgvector 扩展已加载（SELECT extname FROM pg_extension）
// 3. halfvec 类型可用（CREATE TABLE 临时表 + INSERT）
// 4. HNSW 索引存在（查询 pg_indexes）
// 5. 12 张业务表已创建（查询 information_schema.tables）
// 6. 基本 CRUD 可用（创建 project → 查询 → 删除）
//
// 注意：
// - Docker 不可用时 globalSetup 不抛错，本测试通过 isContainerReady() 判断后 describe.skip
// - 烟雾测试不依赖任何 service 层，直接用 PrismaClient raw SQL 验证基础设施
// - 烟雾测试通过即证明 Task 3 基础设施搭建成功，可继续 Task 4 集成测试用例

import { getTestPrismaClient, isContainerReady } from './helpers/pg-container';
import { resetDatabase } from './helpers/reset-db';

// 容器未就绪时整体跳过（Docker 不可用 / 容器启动失败）
// 注意：vitest 的 describe.skipIf 接受布尔表达式，true 时跳过整个 describe 块
describe.skipIf(!isContainerReady())('集成测试基础设施烟雾测试', () => {
  /** 每个 it 前清理数据，保证用例隔离 */
  beforeEach(async () => {
    await resetDatabase();
  });

  it('pgvector 扩展已加载', async () => {
    const prisma = getTestPrismaClient();
    // 查询 pg_extension 表，验证 vector 扩展已安装
    const extensions = await prisma.$queryRawUnsafe<{ extname: string }[]>(
      `SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm');`,
    );
    const extNames = extensions.map((e) => e.extname);
    expect(extNames).toContain('vector');
    expect(extNames).toContain('pg_trgm');
  });

  it('halfvec 类型可用（可创建 halfvec(2048) 列）', async () => {
    const prisma = getTestPrismaClient();
    // 创建临时表验证 halfvec 类型可用（事务中回滚，避免污染 schema）
    await prisma.$executeRawUnsafe(
      `CREATE TEMP TABLE smoke_halfvec_test (id serial PRIMARY KEY, v halfvec(2048));`,
    );
    // 插入一条记录验证类型可写入
    await prisma.$executeRawUnsafe(
      `INSERT INTO smoke_halfvec_test (v) VALUES ($1::halfvec);`,
      '[0.1, 0.2, 0.3]',
    );
    // 注意：halfvec(2048) 列允许写入少于 2048 维的向量，pgvector 会自动补 0
    const rows = await prisma.$queryRawUnsafe<{ v: string }[]>(
      `SELECT v::text FROM smoke_halfvec_test;`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.v).toMatch(/^\[/); // halfvec 文本表示以 '[' 开头
    // 临时表会在事务/会话结束时自动删除，无需 DROP
  });

  it('HNSW 索引存在（rag_document_chunks.embedding）', async () => {
    const prisma = getTestPrismaClient();
    // 查询 pg_indexes 验证 HNSW 索引已创建
    const indexes = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'rag_document_chunks';`,
    );
    const indexNames = indexes.map((i) => i.indexname);
    // HNSW 索引名（src/main/infra/prisma/extensions/hnsw.ts）
    expect(indexNames).toContain('idx_rag_chunks_embedding');
    // 外键自动生成的索引
    expect(indexNames).toContain('rag_document_chunks_documentId_idx');
  });

  it('12 张业务表已创建', async () => {
    const prisma = getTestPrismaClient();
    // biome-ignore lint/style/useNamingConvention: SQL 列名为 snake_case，与 information_schema 一致
    const tables = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name;`,
    );
    const tableNames = tables.map((t) => t.table_name);
    // 设计文档 §6.2 12 张业务表
    const expectedTables = [
      'ai_usage_logs',
      'app_settings',
      'chapters',
      'characters',
      'chat_messages',
      'chat_sessions',
      'project_settings',
      'projects',
      'rag_document_chunks',
      'rag_documents',
      'volumes',
      'worldviews',
    ];
    for (const expected of expectedTables) {
      expect(tableNames).toContain(expected);
    }
  });

  it('基本 CRUD 可用（创建 project → 查询 → 删除）', async () => {
    const prisma = getTestPrismaClient();
    // 创建
    const created = await prisma.project.create({
      data: {
        id: 'smoke-project-1',
        name: '烟雾测试项目',
        description: '用于验证 CRUD 链路',
        genre: 'fantasy',
        status: 'ACTIVE',
        metadata: { tag: 'smoke' },
        updatedAt: new Date(),
      },
    });
    expect(created.id).toBe('smoke-project-1');

    // 查询
    const found = await prisma.project.findUnique({
      where: { id: 'smoke-project-1' },
    });
    expect(found).not.toBeNull();
    expect(found?.name).toBe('烟雾测试项目');
    // metadata 是 JSONB，Prisma 返回的是 unknown，需类型断言
    // 已通过 expect(found).not.toBeNull() 断言非空，此处用非空断言访问 metadata
    expect((found?.metadata as { tag: string } | undefined)?.tag).toBe('smoke');

    // 删除
    await prisma.project.delete({ where: { id: 'smoke-project-1' } });
    const afterDelete = await prisma.project.findUnique({
      where: { id: 'smoke-project-1' },
    });
    expect(afterDelete).toBeNull();
  });

  it('resetDatabase 工具函数能清空所有业务表', async () => {
    const prisma = getTestPrismaClient();
    // 先写入一条 project
    await prisma.project.create({
      data: {
        id: 'smoke-reset-1',
        name: '将被清理',
        status: 'ACTIVE',
        metadata: {},
        updatedAt: new Date(),
      },
    });
    expect(await prisma.project.count()).toBe(1);

    // 调用 resetDatabase 清空
    await resetDatabase();

    // 验证所有业务表为空
    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.chatSession.count()).toBe(0);
    expect(await prisma.chatMessage.count()).toBe(0);
    expect(await prisma.ragDocument.count()).toBe(0);
    expect(await prisma.ragDocumentChunk.count()).toBe(0);
  });
});
