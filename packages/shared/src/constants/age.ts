// packages/shared/src/constants/age.ts
// Apache AGE 图数据常量（设计文档 §6.3）
//
// 业务图：novel_graph
// - 顶点标签 Character（属性：characterId, name, role）
// - 边标签 RELATION（属性：type, description, chapterId）
// - 通过 Prisma $executeRawUnsafe / $queryRawUnsafe 透传 Cypher
//
// 注意：常量名采用全大写下划线（行业惯例），与 AGE 官方文档一致
// biome.json 已为 constants/age.ts 关闭 useNamingConvention 规则

/** AGE Graph 名（novel writer agent 业务图） */
export const AGE_GRAPH_NAME = 'novel_graph';

/** 顶点标签：人物 */
export const AGE_VERTEX_LABEL = {
  /** 人物顶点（属性：characterId, name, role） */
  CHARACTER: 'Character',
} as const;

/** 边标签：人物关系 */
export const AGE_EDGE_LABEL = {
  /** 人物关系边（属性：type, description, chapterId） */
  RELATION: 'RELATION',
} as const;
