// packages/shared/src/types/enums.ts
// 业务实体状态枚举
// 来源：设计文档 §6.2 Prisma Schema 的 enum 定义
// 注意：使用 as const + 字面量联合类型，避免 TS enum 的运行时对象开销
// Phase 4 引入 Prisma 后，Prisma 生成类型会 alias 到这里

/** 项目状态 */
export const ProjectStatus = {
  ACTIVE: 'ACTIVE',
  ARCHIVED: 'ARCHIVED',
  DRAFT: 'DRAFT',
} as const;
export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];

/** 章节状态 */
export const ChapterStatus = {
  DRAFT: 'DRAFT',
  OUTLINE: 'OUTLINE',
  WRITING: 'WRITING',
  COMPLETED: 'COMPLETED',
  REVISION: 'REVISION',
} as const;
export type ChapterStatus = (typeof ChapterStatus)[keyof typeof ChapterStatus];

/** 人物角色定位 */
export const CharacterRole = {
  PROTAGONIST: 'PROTAGONIST',
  ANTAGONIST: 'ANTAGONIST',
  SUPPORTING: 'SUPPORTING',
  MINOR: 'MINOR',
} as const;
export type CharacterRole = (typeof CharacterRole)[keyof typeof CharacterRole];

/** 对话消息角色（对齐 OpenAI ChatCompletionRole） */
export const ChatRole = {
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
} as const;
export type ChatRole = (typeof ChatRole)[keyof typeof ChatRole];
