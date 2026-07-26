// src/main/infra/storage/schema.ts
// Drizzle ORM Schema：会话持久化表结构定义
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义 sessions / messages 两张表的列结构
// - 作为 drizzle-orm 类型推导的单一真源（无需手写 TypeScript 类型）
//
// 表设计：
// - sessions：会话元数据（id / title / createdAt / updatedAt / lastMessage / messageCount）
// - messages：消息历史（id / sessionId / seq / role / content / createdAt）
//   - seq 是消息序号（从 0 递增），用于排序与范围查询
//   - content 是 JSON 字符串（完整 ModelMessage 序列化）
//
// 索引：
// - sessions.updatedAt DESC：list 接口按 updatedAt 倒序
// - messages.sessionId + seq：get 接口按 sessionId 过滤、seq 升序
// ──────────────────────────────────────────────────────────────

import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * sessions 表：会话元数据
 *
 * 一个会话对应一次 agent:run（或 chat:send）的完整对话历史。
 * title 用户可编辑，默认取首条用户消息前 50 字符。
 * lastMessage 是最后一条用户消息预览（前 100 字符，用于列表展示）。
 */
export const sessions = sqliteTable('sessions', {
  /** 会话唯一 id（UUID，由 SessionService.create 生成） */
  id: text('id').primaryKey(),
  /** 会话标题（用户可编辑，默认取首条用户消息前 50 字符） */
  title: text('title').notNull(),
  /** 创建时间（Unix timestamp 毫秒） */
  createdAt: integer('created_at').notNull(),
  /** 最后更新时间（Unix timestamp 毫秒） */
  updatedAt: integer('updated_at').notNull(),
  /** 最后一条用户消息预览（前 100 字符，用于列表展示） */
  lastMessage: text('last_message'),
  /** 消息数量（冗余字段，避免 list 时 COUNT(*) 全表扫描） */
  messageCount: integer('message_count').notNull().default(0),
  /** 会话级项目工作目录（绝对路径，agent 工具操作边界） */
  workingDir: text('working_dir').notNull(),
});

/**
 * messages 表：消息历史
 *
 * 一行对应一条 ModelMessage（user / assistant / tool 等）。
 * content 存储完整 ModelMessage 的 JSON 序列化字符串，
 * 由 SessionService 序列化/反序列化。
 *
 * seq 是消息序号（从 0 递增），同一 sessionId 内唯一递增。
 */
export const messages = sqliteTable('messages', {
  /** 消息唯一 id（自增，SQLite rowid） */
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 所属会话 id（外键关联 sessions.id） */
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  /** 消息序号（从 0 递增，用于排序） */
  seq: integer('seq').notNull(),
  /** 消息角色（user / assistant / tool / system，便于按角色过滤） */
  role: text('role').notNull(),
  /** 完整 ModelMessage 的 JSON 序列化字符串 */
  content: text('content').notNull(),
  /** 创建时间（Unix timestamp 毫秒） */
  createdAt: integer('created_at').notNull(),
  // 索引：sessionId + seq 复合索引，加速 get 查询
  // drizzle-orm/sqlite-core 不直接支持复合索引声明，
  // 在 db.ts 初始化时通过 CREATE INDEX 创建
});

/** sessions 表类型（插入类型，id 由调用方生成） */
export type SessionRow = typeof sessions.$inferSelect;
/** sessions 表插入类型（id 必填，createdAt/updatedAt 必填） */
export type SessionInsert = typeof sessions.$inferInsert;

/**
 * prompts 表：System Prompt 模板存储
 *
 * 用户选择的"数据库存储"方案：
 * - 默认 prompt 在 PromptService.initialize 时插入（id 固定，重复插入跳过）
 * - 用户可编辑 prompt 内容（未来通过设置界面）
 * - 支持多 agent 角色（虽然 MVP 只有一个 code-agent，但表结构预留 role 字段）
 *
 * 设计参考 codex 的 SkillMetadata + MiMo-Code 的 prompt 模板分离设计：
 * - 内容（content）与元数据（name/description/role）分离
 * - isDefault 标记内置 prompt，防止用户误删
 * - updatedAt 用于追踪用户编辑
 */
export const prompts = sqliteTable('prompts', {
  /** Prompt 唯一标识（如 'code-agent'，主键） */
  id: text('id').primaryKey(),
  /** 显示名称（如 'Code Agent'） */
  name: text('name').notNull(),
  /** 描述（如 '通用代码助手默认行为'） */
  description: text('description').notNull(),
  /** Agent 角色标识（当前仅 'code-agent'，预留扩展） */
  role: text('role').notNull(),
  /** Prompt 内容（支持模板变量：{{workingDir}} / {{os}} / {{gitBranch}} 等） */
  content: text('content').notNull(),
  /** 是否为内置默认 prompt（true 不可删除，但可编辑） */
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(true),
  /** 创建时间（Unix timestamp 毫秒） */
  createdAt: integer('created_at').notNull(),
  /** 最后更新时间（Unix timestamp 毫秒） */
  updatedAt: integer('updated_at').notNull(),
});

/** messages 表类型 */
export type MessageRow = typeof messages.$inferSelect;
/** messages 表插入类型（id 自增，不传） */
export type MessageInsert = typeof messages.$inferInsert;

/** prompts 表类型 */
export type PromptRow = typeof prompts.$inferSelect;
/** prompts 表插入类型 */
export type PromptInsert = typeof prompts.$inferInsert;

// ─── 网文写作平台 9 张表 ─────────────────────────────────

/**
 * novel_projects 表：写作项目
 */
export const novelProjects = sqliteTable('novel_projects', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  author: text('author').notNull(),
  genre: text('genre').notNull(),
  description: text('description'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * volumes 表：卷
 */
export const volumes = sqliteTable('volumes', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => novelProjects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  summary: text('summary'),
  createdAt: integer('created_at').notNull(),
});

/**
 * chapters 表：章
 */
export const chapters = sqliteTable('chapters', {
  id: text('id').primaryKey(),
  volumeId: text('volume_id')
    .notNull()
    .references(() => volumes.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  content: text('content'),
  wordCount: integer('word_count').notNull().default(0),
  summary: text('summary'),
  status: text('status').notNull().default('draft'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * scenes 表：节
 */
export const scenes = sqliteTable('scenes', {
  id: text('id').primaryKey(),
  chapterId: text('chapter_id')
    .notNull()
    .references(() => chapters.id, { onDelete: 'cascade' }),
  title: text('title'),
  sortOrder: integer('sort_order').notNull().default(0),
  summary: text('summary'),
  content: text('content'),
});

/**
 * outline_items 表：大纲项（卷纲/章纲/节纲统一表，自引用树）
 */
export const outlineItems = sqliteTable('outline_items', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => novelProjects.id, { onDelete: 'cascade' }),
  parentId: text('parent_id'),
  level: text('level', { enum: ['volume', 'chapter', 'scene'] }).notNull(),
  title: text('title').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  summary: text('summary'),
  targetWordCount: integer('target_word_count').default(0),
  emotionalGoal: text('emotional_goal'),
  pacing: text('pacing'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * characters 表：角色
 */
export const characters = sqliteTable('characters', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => novelProjects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  aliases: text('aliases'),
  role: text('role', { enum: ['主角', '重要', '次要'] }).notNull().default('次要'),
  appearance: text('appearance'),
  personality: text('personality'),
  background: text('background'),
  abilities: text('abilities'),
  status: text('status'),
  avatarUrl: text('avatar_url'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * character_relationships 表：角色关系
 */
export const characterRelationships = sqliteTable('character_relationships', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => novelProjects.id, { onDelete: 'cascade' }),
  characterAId: text('character_a_id')
    .notNull()
    .references(() => characters.id, { onDelete: 'cascade' }),
  characterBId: text('character_b_id')
    .notNull()
    .references(() => characters.id, { onDelete: 'cascade' }),
  relationshipType: text('relationship_type').notNull(),
  description: text('description'),
  createdAt: integer('created_at').notNull(),
});

/**
 * world_settings 表：世界观设定
 */
export const worldSettings = sqliteTable('world_settings', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => novelProjects.id, { onDelete: 'cascade' }),
  category: text('category').notNull(),
  title: text('title').notNull(),
  content: text('content'),
  tags: text('tags'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * writing_sessions 表：写作会话（AI 对话记录）
 */
export const writingSessions = sqliteTable('writing_sessions', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => novelProjects.id, { onDelete: 'cascade' }),
  chapterId: text('chapter_id'),
  sessionType: text('session_type', {
    enum: ['write', 'review', 'inspiration'],
  }).notNull(),
  messages: text('messages'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// 类型导出
export type NovelProjectRow = typeof novelProjects.$inferSelect;
export type NovelProjectInsert = typeof novelProjects.$inferInsert;
export type VolumeRow = typeof volumes.$inferSelect;
export type VolumeInsert = typeof volumes.$inferInsert;
export type ChapterRow = typeof chapters.$inferSelect;
export type ChapterInsert = typeof chapters.$inferInsert;
export type SceneRow = typeof scenes.$inferSelect;
export type SceneInsert = typeof scenes.$inferInsert;
export type OutlineItemRow = typeof outlineItems.$inferSelect;
export type OutlineItemInsert = typeof outlineItems.$inferInsert;
export type CharacterRow = typeof characters.$inferSelect;
export type CharacterInsert = typeof characters.$inferInsert;
export type CharacterRelationshipRow = typeof characterRelationships.$inferSelect;
export type CharacterRelationshipInsert = typeof characterRelationships.$inferInsert;
export type WorldSettingRow = typeof worldSettings.$inferSelect;
export type WorldSettingInsert = typeof worldSettings.$inferInsert;
export type WritingSessionRow = typeof writingSessions.$inferSelect;
export type WritingSessionInsert = typeof writingSessions.$inferInsert;

// 导出 schema 对象供 db.ts 创建表
export const schema = {
  sessions,
  messages,
  prompts,
  novelProjects,
  volumes,
  chapters,
  scenes,
  outlineItems,
  characters,
  characterRelationships,
  worldSettings,
  writingSessions,
};

// 防止 ts 报未使用 sql 导入（未来 CREATE INDEX 会用到）
void sql;
