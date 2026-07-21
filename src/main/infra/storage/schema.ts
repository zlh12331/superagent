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

/** messages 表类型 */
export type MessageRow = typeof messages.$inferSelect;
/** messages 表插入类型（id 自增，不传） */
export type MessageInsert = typeof messages.$inferInsert;

// 导出 schema 对象供 db.ts 创建表
export const schema = {
  sessions,
  messages,
};

// 防止 ts 报未使用 sql 导入（未来 CREATE INDEX 会用到）
void sql;
