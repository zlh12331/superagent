import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';
export type RunStatus = 'idle' | 'running' | 'interrupted';
export type SkillSource = 'learned' | 'builtin';
export type TurnStatus = 'completed' | 'aborted' | 'max-steps' | 'error';
export type GoalStatus = 'active' | 'completed' | 'aborted';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TaskKind = 'agent' | 'shell';

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

export const runtimeModels = sqliteTable(
  'runtime_models',
  {
    modelId: text('model_id').primaryKey(),
    providerKind: text('provider_kind').notNull(),
    baseUrl: text('base_url'),
    displayName: text('display_name'),
    timeoutMs: integer('timeout_ms'),
    apiFormat: text('api_format'),
    isEnabled: integer('is_enabled').$type<0 | 1>().notNull().default(1),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [check('chk_runtime_models_is_enabled', sql`${t.isEnabled} IN (0,1)`)],
);

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

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  kind: text('kind').$type<TaskKind>().notNull(),
  description: text('description').notNull(),
  status: text('status').$type<TaskStatus>().notNull(),
  startTime: integer('start_time').notNull(),
  endTime: integer('end_time'),
});

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

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

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
