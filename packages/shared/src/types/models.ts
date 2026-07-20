// packages/shared/src/types/models.ts
// 业务实体类型定义（仅 schemas 未覆盖的独有类型）
// 来源：设计文档 §6.2 Prisma Schema 字段
//
// 类型真理源策略（Zod 4 最佳实践）：
// - 所有可在 IPC 边界校验的实体（Project/Chapter/Character/Worldview/
//   ChatSession/ChatMessage/RagDocument/ProjectSetting/AppSetting）类型
//   由 schemas/*.schema.ts 派生（z.infer），运行时校验与类型派生同源
// - 本文件仅保留 schemas 未覆盖的独有类型：
//   - ISODateString：时间戳别名（被 schemas 复用）
//   - Volume：卷宗实体（暂未建 schema，未来若加 CRUD 再迁移）
//   - CharacterRelation：AGE 图边（不通过 Prisma 表，由 Cypher 透传查询）
//   - RagDocumentChunk：RAG 切片（向量不跨 IPC 传输，故无运行时校验需求）
//   - AiUsageLog：AI 调用日志（暂无 IPC channel，主进程内部使用）
//
// 注意：本文件不依赖 Prisma（避免 packages/shared → @prisma/client 循环依赖）

/** ISO 8601 字符串时间戳（Prisma DateTime 在 IPC 边界序列化为 string） */
export type ISODateString = string;

/**
 * 卷宗
 *
 * 暂未建 Zod schema：当前无卷宗 CRUD IPC channel，仅作为 Chapter.volumeId 的元信息。
 * 未来若增加卷宗管理（创建/列表/删除），应迁移为 VolumeSchema + z.infer 派生。
 */
export interface Volume {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly summary?: string | null;
  readonly sortOrder: number;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

/**
 * 人物关系（AGE 图边，不在 Prisma 表中，通过 Cypher 透传查询）
 *
 * 不建 Zod schema：关系入参用 CharacterRelationInputSchema 校验，
 * 查询结果直接通过 AGE Cypher 返回，结构由查询 SQL 决定（无需运行时校验）。
 */
export interface CharacterRelation {
  readonly fromCharacterId: string;
  readonly toCharacterId: string;
  readonly type: string;
  readonly description?: string;
  readonly chapterId?: string;
}

/**
 * RAG 文档切片（不含 embedding，向量不跨 IPC 传输）
 *
 * 不建 Zod schema：当前无独立 IPC channel 返回切片列表
 * （rag:search 返回 RagSearchResultItem，已含 content 字段）。
 */
export interface RagDocumentChunk {
  readonly id: string;
  readonly documentId: string;
  readonly content: string;
  readonly chunkIndex: number;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: ISODateString;
}

/**
 * AI 调用日志
 *
 * 不建 Zod schema：当前无 IPC channel 暴露日志查询，主进程内部使用。
 * 未来若加 admin UI 查看调用日志，应迁移为 AiUsageLogSchema + z.infer 派生。
 */
export interface AiUsageLog {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
  readonly status: string;
  readonly error?: string | null;
  readonly createdAt: ISODateString;
}
