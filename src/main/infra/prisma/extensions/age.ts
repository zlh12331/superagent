// src/main/infra/prisma/extensions/age.ts
// Apache AGE 扩展管理器（设计文档 §6.3 + §6.5）
//
// 职责：
// 1. CREATE EXTENSION age + LOAD 'age' + SET search_path
// 2. 创建 Graph（ag_catalog.create_graph）
// 3. 提供 Cypher 透传 API（executeCypher / queryCypher）
// 4. AGE 加载失败时返回 false（由调用方决定是否降级 PG 版本）
//
// 注意：
// - Cypher 语句通过 ag_catalog.cypher() 函数包裹，返回 SETOF record
// - 必须用 Prisma $executeRawUnsafe / $queryRawUnsafe（Prisma 不原生支持 Cypher）
// - ag_catalog.create_graph 不幂等：已存在时抛 'graph "xxx" already exists'（错误码 3F000）
//   故用 DO 块 + ag_catalog.ag_graph 系统表查询实现幂等（重启时不报错）

import { AGE_GRAPH_NAME } from '@novel-writer/shared';
import { logger } from '../../../utils/logger';

/**
 * Prisma 数据库执行器接口（兼容 PrismaClient 与事务 tx client）
 *
 * 设计文档 §4.3 infra 层职责：Repository 模式需要把 AGE 操作纳入事务边界
 * - PrismaClient 满足此接口（结构兼容）
 * - Prisma 7 的 TransactionClient 也满足此接口
 * - 这样 Repository 可以把 AGE 操作放在 $transaction(async (tx) => ...) 内
 *   保证 Prisma 写入 + AGE 写入的原子性（AGE 1.5 支持 PostgreSQL 事务回滚）
 */
interface DbExecutor {
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T[]>;
}

/**
 * AGE Graph 初始化 SQL（设计文档 §6.3）
 *
 * - CREATE EXTENSION IF NOT EXISTS age（幂等）
 * - LOAD 'age'（每个会话需重新 LOAD，但 Prisma 连接池中只执行一次足够）
 * - SET search_path（让 ag_catalog.cypher 函数可直接调用）
 */
const AGE_INIT_SQL = `
  CREATE EXTENSION IF NOT EXISTS age;
  LOAD 'age';
  SET search_path = ag_catalog, "$user", public;
`;

/**
 * 创建 Graph SQL（幂等：若已存在则跳过）
 *
 * ag_catalog.create_graph 第二参数是 Graph 名
 *
 * 实现细节：
 * - ag_catalog.create_graph 不幂等，已存在时抛 'graph "xxx" already exists'（3F000）
 * - 用 PL/pgSQL DO 块 + ag_catalog.ag_graph 系统表查询实现幂等
 * - 仅当 graph 不存在时 PERFORM create_graph
 * - 重启场景下 graph 已存在 → DO 块直接结束，不抛错
 */
const CREATE_GRAPH_SQL = `
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_graph WHERE name = '${AGE_GRAPH_NAME}') THEN
      PERFORM ag_catalog.create_graph('${AGE_GRAPH_NAME}');
    END IF;
  END $$;
`;

/**
 * 加载 AGE 扩展并初始化 Graph
 *
 * @returns true 成功；false 失败（AGE 不兼容当前 PG 版本）
 */
export async function ensureAgeExtension(client: DbExecutor): Promise<boolean> {
  try {
    logger.info({}, '加载 Apache AGE 扩展');
    await client.$executeRawUnsafe(AGE_INIT_SQL);
    await client.$executeRawUnsafe(CREATE_GRAPH_SQL);
    logger.info({ graph: AGE_GRAPH_NAME }, 'AGE 扩展加载完成，Graph 已创建');
    return true;
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'AGE 扩展加载失败（可能 PG 版本不兼容）',
    );
    return false;
  }
}

/**
 * 执行 Cypher 写操作（无返回值）
 *
 * @param cypher Cypher 语句（不含 ag_catalog.cypher 包裹）
 *
 * @example
 * ```ts
 * await executeCypher(client, `
 *   CREATE (n:Character {characterId: 'abc', name: '主角', role: 'PROTAGONIST'})
 * `);
 * ```
 */
export async function executeCypher(client: DbExecutor, cypher: string): Promise<number> {
  // ag_catalog.cypher 第二参数是 Cypher 字符串
  // 返回 SETOF record，但 CREATE/DELETE/MERGE 等写操作不需要 RETURNING
  const sql = `SELECT * FROM ag_catalog.cypher('${AGE_GRAPH_NAME}', $$ ${cypher} $$) AS (result agtype);`;
  return client.$executeRawUnsafe(sql);
}

/**
 * 查询 Cypher 返回结果
 *
 * @param cypher Cypher 语句（含 RETURNING）
 * @returns 查询结果数组（agtype 类型）
 *
 * @example
 * ```ts
 * const results = await queryCypher(client, `
 *   MATCH (n:Character) RETURN n.characterId, n.name
 * `);
 * ```
 */
export async function queryCypher<T = unknown>(client: DbExecutor, cypher: string): Promise<T[]> {
  const sql = `SELECT * FROM ag_catalog.cypher('${AGE_GRAPH_NAME}', $$ ${cypher} $$) AS (result agtype);`;
  // 注意：$queryRawUnsafe<T> 已返回 Promise<T[]>，不能再传 T[] 否则变成 Promise<T[][]>
  const rows = await client.$queryRawUnsafe<T>(sql);
  return rows;
}

/**
 * 转义 Cypher 字符串值中的单引号
 *
 * Cypher 字符串用单引号包裹，单引号本身需要转义为两个单引号 ''
 * 例如：name = "O'Neil" → Cypher 中写为 'O''Neil'
 *
 * @param value 原始字符串值
 * @returns 转义后的字符串值（不含外层引号）
 */
function escapeCypherString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * 创建 Character 顶点（便捷方法）
 *
 * @param characterId Character 表 id
 * @param name 角色名
 * @param role 角色定位
 */
export async function createCharacterVertex(
  client: DbExecutor,
  params: { characterId: string; name: string; role: string },
): Promise<number> {
  const cypher = `CREATE (n:Character {characterId: '${escapeCypherString(params.characterId)}', name: '${escapeCypherString(params.name)}', role: '${escapeCypherString(params.role)}'})`;
  return executeCypher(client, cypher);
}

/**
 * 创建 RELATION 边（便捷方法）
 *
 * @param fromCharacterId 起始角色 id
 * @param toCharacterId 目标角色 id
 * @param type 关系类型（如 'friend', 'enemy', 'mentor'）
 * @param description 关系描述
 * @param chapterId 关联章节 id
 */
export async function createRelationEdge(
  client: DbExecutor,
  params: {
    fromCharacterId: string;
    toCharacterId: string;
    type: string;
    description?: string;
    chapterId?: string;
  },
): Promise<number> {
  const props = [
    `type: '${escapeCypherString(params.type)}'`,
    params.description ? `description: '${escapeCypherString(params.description)}'` : '',
    params.chapterId ? `chapterId: '${escapeCypherString(params.chapterId)}'` : '',
  ]
    .filter(Boolean)
    .join(', ');

  // 先 MATCH 两个顶点，再 CREATE 关系
  const cypher = `
    MATCH (a:Character {characterId: '${escapeCypherString(params.fromCharacterId)}'}),
          (b:Character {characterId: '${escapeCypherString(params.toCharacterId)}'})
    CREATE (a)-[r:RELATION {${props}}]->(b)
  `;
  return executeCypher(client, cypher);
}
