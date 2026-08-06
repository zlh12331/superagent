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
  /** 最近运行状态：idle=空闲，running=进行中，interrupted=异常中断（崩溃恢复识别） */
  lastRunStatus: text('last_run_status').notNull().default('idle'),
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
  /** 所属回合 id（Transcript 消息级明细；null = 旧数据/未归属回合） */
  turnId: text('turn_id'),
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

/**
 * token_usage 表：每次 LLM 调用的 token 用量记录（设置页用量统计）
 *
 * 设计（对标 qwen tokenUsageService）：
 * - 每次 agent/chat 回合结束写入一行（含模型 + 各维度 token）
 * - cacheReadTokens：KV cache 命中（DeepSeek 非标准字段已映射为 cacheRead）
 * - reasoningTokens：思维链 token（reasoning 模型）
 */
export const tokenUsage = sqliteTable('token_usage', {
  /** 记录唯一 id（自增） */
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 所属会话 id（外键关联 sessions.id，级联删除） */
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  /** 使用的模型 id（如 deepseek-v4-flash） */
  modelId: text('model_id').notNull(),
  /** 输入 token 数 */
  inputTokens: integer('input_tokens').notNull(),
  /** 输出 token 数 */
  outputTokens: integer('output_tokens').notNull(),
  /** 总 token 数 */
  totalTokens: integer('total_tokens').notNull(),
  /** KV cache 命中 token 数（DeepSeek prompt_cache_hit_tokens） */
  cacheReadTokens: integer('cache_read_tokens'),
  /** 思维链 token 数（reasoning 模型） */
  reasoningTokens: integer('reasoning_tokens'),
  /** 创建时间（Unix timestamp 毫秒） */
  createdAt: integer('created_at').notNull(),
});

/** token_usage 表类型 */
export type TokenUsageRow = typeof tokenUsage.$inferSelect;
/** token_usage 表插入类型 */
export type TokenUsageInsert = typeof tokenUsage.$inferInsert;

/**
 * turns 表：Agent 回合记录（Transcript 结构化）
 *
 * 设计（对齐 qwen agent-transcript / chatRecordingService）：
 * - 一次 agent:run 的多轮循环 = 一个回合（turnId 由 AgentRuntime 生成）
 * - 回合结束时写入一行（含模型/终止原因/耗时/token 统计）
 * - 支持回合级查询（续传 / 审计 / 回放的地基）
 */
export const turns = sqliteTable('turns', {
  /** 记录唯一 id（自增） */
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 回合唯一 id（UUID，关联 TurnEvent.turnId） */
  turnId: text('turn_id').notNull(),
  /** 所属会话 id（外键关联 sessions.id，级联删除） */
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  /** 回合序号（会话内递增，从 0 开始） */
  seq: integer('seq').notNull(),
  /** 使用的模型 id */
  modelId: text('model_id').notNull(),
  /** 终止原因：completed/aborted/max-steps/error */
  status: text('status').notNull(),
  /** 输入 token 数 */
  inputTokens: integer('input_tokens'),
  /** 输出 token 数 */
  outputTokens: integer('output_tokens'),
  /** 总 token 数 */
  totalTokens: integer('total_tokens'),
  /** 回合总耗时（毫秒） */
  durationMs: integer('duration_ms'),
  /** 创建时间（Unix timestamp 毫秒） */
  createdAt: integer('created_at').notNull(),
});

/** turns 表类型 */
export type TurnRow = typeof turns.$inferSelect;
/** turns 表插入类型 */
export type TurnInsert = typeof turns.$inferInsert;

/**
 * runtime_models 表：用户手动配置的模型（运行时快照持久化）
 *
 * 设计：
 * - 对应 ModelRegistry 的 RuntimeModelSnapshot（AI 域模型注册表）
 * - apiKey 不落库：存 keychain（key = `runtime:${modelId}`，与 AI 域约定一致）
 * - 应用启动时由 RuntimeModelStore 加载并注册到 modelRegistry
 */
export const runtimeModels = sqliteTable('runtime_models', {
  /** 模型 id（主键，全局唯一） */
  modelId: text('model_id').primaryKey(),
  /** 所属供应商 kind（决定 SDK 协议） */
  providerKind: text('provider_kind').notNull(),
  /** 显式 baseUrl（覆盖供应商默认端点；null = 用默认） */
  baseUrl: text('base_url'),
  /** 创建时间（Unix timestamp 毫秒） */
  createdAt: integer('created_at').notNull(),
});

/**
 * goals 表：会话目标跟踪（对齐 qwen /goal 语义，持久化替代内存态）
 *
 * 设计：
 * - 目标绑定会话（sessionId 外键）；每会话一个 active 目标（新建覆盖旧）
 * - 回合结束后由 GoalService 用 LLM 判定 condition 是否满足（goalJudge）
 * - status：active（进行中）/ completed（判定满足）/ aborted（用户清除）
 */
export const goals = sqliteTable('goals', {
  /** 自增主键 */
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 所属会话 id（外键关联 sessions.id） */
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  /** 目标条件描述（用户注册的完成条件） */
  condition: text('condition').notNull(),
  /** 状态：active / completed / aborted */
  status: text('status').notNull(),
  /** 已判定回合数 */
  iterations: integer('iterations').notNull().default(0),
  /** 最近一次判定理由（LLM 输出或错误说明） */
  lastReason: text('last_reason'),
  /** 创建时间（Unix timestamp 毫秒） */
  createdAt: integer('created_at').notNull(),
  /** 完成/清除时间（null = 未结束） */
  finishedAt: integer('finished_at'),
});

/**
 * memories 表：跨会话记忆条目（对齐 qwen channel-memory 语义收敛）
 *
 * 设计：
 * - 记忆条目（content + kind：fact 事实 / preference 偏好）绑定会话
 * - 回合结束后由 MemoryService 用 LLM 提取（转录证据），敏感信息过滤
 * - 会话开始时注入上下文（systemPrompt 附加记忆摘要）
 */
export const memories = sqliteTable('memories', {
  /** 自增主键 */
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 所属会话 id（外键关联 sessions.id） */
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  /** 记忆内容 */
  content: text('content').notNull(),
  /** 记忆类别：fact 事实 / preference 偏好 */
  kind: text('kind').notNull(),
  /** 来源回合 id（去重用） */
  sourceTurnId: text('source_turn_id'),
  /** 创建时间（Unix timestamp 毫秒） */
  createdAt: integer('created_at').notNull(),
});

/** memories 表类型 */
export type MemoryRow = typeof memories.$inferSelect;
/** memories 表插入类型 */
export type MemoryInsert = typeof memories.$inferInsert;

/**
 * tasks 表：任务状态机持久化（对齐 qwen tasks 语义收敛）
 *
 * 设计：
 * - 任务条目（委派工作单元）绑定会话
 * - 内存注册表升级为 sqlite 持久化（重启后任务历史保留）
 */
export const tasks = sqliteTable('tasks', {
  /** 任务 id（uuid 主键） */
  id: text('id').primaryKey(),
  /** 所属会话 id（无外键：任务可关联任意 id，含子代理内部回合 sessionId） */
  sessionId: text('session_id').notNull(),
  /** 任务种类（agent / shell） */
  kind: text('kind').notNull(),
  /** 人类可读描述 */
  description: text('description').notNull(),
  /** 状态（pending / running / completed / failed / cancelled） */
  status: text('status').notNull(),
  /** 创建时间（Unix timestamp 毫秒） */
  startTime: integer('start_time').notNull(),
  /** 结束时间（null = 未结束） */
  endTime: integer('end_time'),
});

/**
 * cron_tasks 表：定时任务（对齐 qwen cronScheduler durable 语义收敛）
 */
export const cronTasks = sqliteTable('cron_tasks', {
  /** 任务 id（uuid 主键） */
  id: text('id').primaryKey(),
  /** 所属会话 id（创建者） */
  sessionId: text('session_id').notNull(),
  /** cron 表达式（5 字段） */
  expression: text('expression').notNull(),
  /** 任务描述 */
  description: text('description').notNull(),
  /** 下次触发时间（Unix 毫秒；null = 未启用） */
  nextFireAt: integer('next_fire_at'),
  /** 是否启用 */
  enabled: integer('enabled').notNull().default(1),
  /** 创建时间 */
  createdAt: integer('created_at').notNull(),
});

export type CronTaskRow = typeof cronTasks.$inferSelect;

/**
 * skills 表：学习到的技能（learn-skill-agent 产物；source=learned）
 */
export const skills = sqliteTable('skills', {
  /** 技能名（snake_case 主键） */
  name: text('name').primaryKey(),
  /** 一句话描述 */
  description: text('description').notNull(),
  /** 技能提示词 */
  prompt: text('prompt').notNull(),
  /** 来源（learned / builtin） */
  source: text('source').notNull().default('learned'),
  /** 创建时间 */
  createdAt: integer('created_at').notNull(),
});

export type SkillRow = typeof skills.$inferSelect;

/** tasks 表类型 */
export type TaskRow = typeof tasks.$inferSelect;
/** tasks 表插入类型 */
export type TaskInsert = typeof tasks.$inferInsert;

/** goals 表类型 */
export type GoalRow = typeof goals.$inferSelect;
/** goals 表插入类型 */
export type GoalInsert = typeof goals.$inferInsert;

/** runtime_models 表类型 */
export type RuntimeModelRow = typeof runtimeModels.$inferSelect;
/** runtime_models 表插入类型 */
export type RuntimeModelInsert = typeof runtimeModels.$inferInsert;

// 导出 schema 对象供 db.ts 创建表
export const schema = {
  sessions,
  messages,
  prompts,
  tokenUsage,
  turns,
  runtimeModels,
  goals,
  memories,
  tasks,
  cronTasks,
  skills,
};

// 防止 ts 报未使用 sql 导入（未来 CREATE INDEX 会用到）
void sql;
