// packages/shared/src/types/models.ts
// 业务实体类型定义
// 来源：设计文档 §6.2 Prisma Schema 字段
// 注意：Phase 4 引入 Prisma 后，可通过 type alias 让 Prisma 生成类型对齐此处定义
// 此处独立定义是为了让 packages/shared 不依赖 Prisma（避免循环依赖）

import type { ChapterStatus, CharacterRole, ChatRole, ProjectStatus } from './enums';

/** ISO 8601 字符串时间戳（Prisma DateTime 在 IPC 边界序列化为 string） */
export type ISODateString = string;

/** 项目 */
export interface Project {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly genre?: string | null;
  readonly cover?: string | null;
  readonly status: ProjectStatus;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
  readonly archivedAt?: ISODateString | null;
}

/** 卷宗 */
export interface Volume {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly summary?: string | null;
  readonly sortOrder: number;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

/** 章节 */
export interface Chapter {
  readonly id: string;
  readonly projectId: string;
  readonly volumeId?: string | null;
  readonly title: string;
  readonly content: string;
  readonly wordCount: number;
  readonly status: ChapterStatus;
  readonly sortOrder: number;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

/** 人物卡 */
export interface Character {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly avatar?: string | null;
  readonly role: CharacterRole;
  readonly description?: string | null;
  readonly profile: Record<string, unknown>;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

/** 人物关系（AGE 图边，不在 Prisma 表中，通过 Cypher 透传查询） */
export interface CharacterRelation {
  readonly fromCharacterId: string;
  readonly toCharacterId: string;
  readonly type: string;
  readonly description?: string;
  readonly chapterId?: string;
}

/** 世界观条目（自关联树形） */
export interface Worldview {
  readonly id: string;
  readonly projectId: string;
  readonly parentId?: string | null;
  readonly title: string;
  readonly content?: string | null;
  readonly type?: string | null;
  readonly icon?: string | null;
  readonly sortOrder: number;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

/** AI 对话会话 */
export interface ChatSession {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly context: Record<string, unknown>;
  readonly model?: string | null;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

/** AI 对话消息 */
export interface ChatMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly tokens: number;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: ISODateString;
}

/** RAG 文档 */
export interface RagDocument {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly source?: string | null;
  readonly mimeType?: string | null;
  readonly chunksCount: number;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: ISODateString;
}

/** RAG 文档切片（不含 embedding，向量不跨 IPC 传输） */
export interface RagDocumentChunk {
  readonly id: string;
  readonly documentId: string;
  readonly content: string;
  readonly chunkIndex: number;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: ISODateString;
}

/** 项目设置 */
export interface ProjectSetting {
  readonly projectId: string;
  readonly aiModel: string;
  readonly aiTemperature: number;
  readonly aiMaxTokens: number;
  readonly ragEnabled: boolean;
  readonly ragTopK: number;
  readonly ragThreshold: number;
  readonly customPrompts: Record<string, unknown>;
  readonly updatedAt: ISODateString;
}

/** 全局应用设置（KV 结构） */
export interface AppSetting {
  readonly key: string;
  readonly value: string;
  readonly updatedAt: ISODateString;
}

/** AI 调用日志 */
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
