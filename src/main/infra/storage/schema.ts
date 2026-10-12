// schema.ts：全库唯一真源——11 张表 + 领域约束（CHECK/UNIQUE/外键）+ 查询索引
// 迁移 DDL 由 drizzle-kit 从本文件派生（禁止手写第二份建表 SQL）；改这里必须跑
// drizzle-kit generate 并验证 check:schema-drift。AI 层需要枚举类型时从本文件导入，勿重复定义
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

// 枚举策略：稳定枚举（不再扩的）落 DB CHECK；演进枚举（会加值的）只用 $type 应用层约束
//（SQLite 改 CHECK 需重建表，代价高）——sessions.last_run_status/messages.role 是前者，
// goals/tasks 是后者
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';
export type RunStatus = 'idle' | 'running' | 'interrupted';
export type SkillSource = 'learned' | 'builtin';
export type TurnStatus = 'completed' | 'aborted' | 'max-steps' | 'error';
export type GoalStatus = 'active' | 'completed' | 'aborted';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TaskKind = 'agent' | 'shell';

/** 会话主表：lastRunStatus 有 CHECK（触发器兜底迁移 0002 先例——被 FK 引用的表禁止重建式迁移） */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastMessage: text('last_message'),
    messageCount: integer('message_count').notNull().default(0),
    workingDir: text('working_dir').notNull(),
    lastRunStatus: text('last_run_status').$type<RunStatus>().notNull().default('idle'),
    pinned: integer('pinned').notNull().default(0),
  },
  (t) => [
    check(
      'chk_sessions_last_run_status',
      sql`${t.lastRunStatus} IN ('idle','running','interrupted')`,
    ),
    index('idx_sessions_updated_at').on(t.updatedAt),
    index('idx_sessions_pinned_updated').on(t.pinned, t.updatedAt),
    index('idx_sessions_working_dir').on(t.workingDir, t.updatedAt),
  ],
);

/** 消息表：(session, seq) 唯一保序；角色落 CHECK；级联随会话删除 */
export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    turnId: text('turn_id'),
    seq: integer('seq').notNull(),
    role: text('role').$type<MessageRole>().notNull(),
    content: text('content').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    check('chk_messages_role', sql`${t.role} IN ('user','assistant','tool','system')`),
    unique('uq_messages_session_seq').on(t.sessionId, t.seq),
    index('idx_messages_turn').on(t.turnId),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;

/** 系统提示词模板表 */
export const prompts = sqliteTable(
  'prompts',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_prompts_role').on(t.role)],
);

export type MessageRow = typeof messages.$inferSelect;
export type MessageInsert = typeof messages.$inferInsert;

export type PromptRow = typeof prompts.$inferSelect;
export type PromptInsert = typeof prompts.$inferInsert;

/** token 用量流水（按请求追加；缓存读/推理 token 可空——旧模型不报） */
export const tokenUsage = sqliteTable(
  'token_usage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    totalTokens: integer('total_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_token_usage_created_at').on(t.createdAt),
    index('idx_token_usage_session_id').on(t.sessionId),
  ],
);

export type TokenUsageRow = typeof tokenUsage.$inferSelect;
export type TokenUsageInsert = typeof tokenUsage.$inferInsert;

/** 回合记录：turnId 全局唯一 + (session, seq) 会话内有序；token/时长结束时回填 */
export const turns = sqliteTable(
  'turns',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    turnId: text('turn_id').notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    modelId: text('model_id').notNull(),
    status: text('status').$type<TurnStatus>().notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    totalTokens: integer('total_tokens'),
    durationMs: integer('duration_ms'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    unique('uq_turns_turn_id').on(t.turnId),
    unique('uq_turns_session_seq').on(t.sessionId, t.seq),
    index('idx_turns_created_at').on(t.createdAt),
  ],
);

export type TurnRow = typeof turns.$inferSelect;
export type TurnInsert = typeof turns.$inferInsert;

/** 用户自定义模型（运行时新增的供应商模型，区别于内置清单） */
export const runtimeModels = sqliteTable(
  'runtime_models',
  {
    modelId: text('model_id').primaryKey(),
    providerKind: text('provider_kind').notNull(),
    baseUrl: text('base_url'),
    displayName: text('display_name'),
    timeoutMs: integer('timeout_ms'),
    apiFormat: text('api_format'),
    // 用户在高级配置里手填的能力覆盖（JSON：contextWindowSize/maxOutputTokens/vision）；
    // null = 未填写（resolve 时回退内置清单 capabilities）
    capabilities: text('capabilities', { mode: 'json' }),
    isEnabled: integer('is_enabled').$type<0 | 1>().notNull().default(1),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [check('chk_runtime_models_is_enabled', sql`${t.isEnabled} IN (0,1)`)],
);

/** 会话目标（goal-judge 按 condition 判定达成/放弃） */
export const goals = sqliteTable(
  'goals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    condition: text('condition').notNull(),
    status: text('status').$type<GoalStatus>().notNull(),
    iterations: integer('iterations').notNull().default(0),
    lastReason: text('last_reason'),
    createdAt: integer('created_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (t) => [index('idx_goals_session').on(t.sessionId)],
);

/** 后台任务跟踪（agent 子回合 / shell 作业） */
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  kind: text('kind').$type<TaskKind>().notNull(),
  description: text('description').notNull(),
  status: text('status').$type<TaskStatus>().notNull(),
  startTime: integer('start_time').notNull(),
  endTime: integer('end_time'),
});

/** 定时任务（cron 表达式 + 触发目标会话） */
export const cronTasks = sqliteTable(
  'cron_tasks',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    expression: text('expression').notNull(),
    description: text('description').notNull(),
    nextFireAt: integer('next_fire_at'),
    enabled: integer('enabled').$type<0 | 1>().notNull().default(1),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [check('chk_cron_tasks_enabled', sql`${t.enabled} IN (0,1)`)],
);

export type CronTaskRow = typeof cronTasks.$inferSelect;

/** 技能表（learned=LLM 提炼沉淀，builtin=内置） */
export const skills = sqliteTable(
  'skills',
  {
    name: text('name').primaryKey(),
    description: text('description').notNull(),
    prompt: text('prompt').notNull(),
    source: text('source').$type<SkillSource>().notNull().default('learned'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [check('chk_skills_source', sql`${t.source} IN ('learned','builtin')`)],
);

export type SkillRow = typeof skills.$inferSelect;

export type TaskRow = typeof tasks.$inferSelect;
export type TaskInsert = typeof tasks.$inferInsert;

export type GoalRow = typeof goals.$inferSelect;
export type GoalInsert = typeof goals.$inferInsert;

export type RuntimeModelRow = typeof runtimeModels.$inferSelect;
export type RuntimeModelInsert = typeof runtimeModels.$inferInsert;

/** 用户设置键值表（JSON 文本值；渲染层 settings 写穿透目标） */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// 聚合导出：drizzle() 初始化与 migrate 使用的 schema 对象（新增表必须登记进来）
export const schema = {
  sessions,
  messages,
  prompts,
  tokenUsage,
  turns,
  runtimeModels,
  goals,
  tasks,
  cronTasks,
  skills,
  appSettings,
};
