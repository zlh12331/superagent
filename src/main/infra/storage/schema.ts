// src/main/infra/storage/schema.ts
// Drizzle ORM Schema：SQLite 持久化表结构定义（全库唯一真源）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义全部 11 张表的列结构 + 领域约束（CHECK / UNIQUE / 外键）
// - 作为 drizzle-orm 类型推导的单一真源（无需手写 TypeScript 类型）
// - DDL 与迁移由 drizzle-kit 从本文件自动派生（schema-sql.ts / migrations.ts 已退役）
//
// 表清单（11 张）：
// - sessions：会话元数据
// - messages：消息历史
// - prompts：System Prompt 模板
// - token_usage：LLM token 用量
// - turns：Agent 回合记录（Transcript）
// - runtime_models：运行时模型配置快照
// - goals：会话目标跟踪
// - tasks：任务状态机持久化
// - cron_tasks：定时任务
// - skills：学习到的技能
// - app_settings：渲染层用户设置（key-value）
//
// 约束策略（2026-08-24 数据设计收敛）：
// - 稳定枚举 → DB CHECK 约束（一劳永逸，几乎不变）
// - 演进枚举 → TS 联合类型（$type<>），DB 不建 CHECK（SQLite 改 CHECK 需重建表）
// - 唯一性 → UNIQUE 约束（防重复写入）
// - 归属关系 → 外键 + ON DELETE CASCADE（防孤儿行）
// ──────────────────────────────────────────────────────────────

import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

// ── 领域枚举（单一真源：storage 层定义，ai 层需要时从此导入，避免重复定义）──

/** 消息角色（稳定枚举 → DB CHECK 兜底） */
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';
/** 会话最近运行状态（稳定枚举 → DB CHECK 兜底） */
export type RunStatus = 'idle' | 'running' | 'interrupted';
/** 技能来源（稳定枚举 → DB CHECK 兜底） */
export type SkillSource = 'learned' | 'builtin';
/** 回合终止原因（演进枚举 → 应用层类型约束） */
export type TurnStatus = 'completed' | 'aborted' | 'max-steps' | 'error';
/** 目标状态（演进枚举 → 应用层类型约束） */
export type GoalStatus = 'active' | 'completed' | 'aborted';
/** 任务状态（演进枚举 → 应用层类型约束） */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
/** 任务种类（演进枚举 → 应用层类型约束） */
export type TaskKind = 'agent' | 'shell';

/**
 * sessions 表：会话元数据
 *
 * 一个会话对应一次 agent:run（或 chat:send）的完整对话历史。
 * title 用户可编辑，默认取首条用户消息前 50 字符。
 * lastMessage 是最后一条用户消息预览（前 100 字符，用于列表展示）。
 */
export const sessions = sqliteTable(
  'sessions',
  {
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
    /** 消息数量（冗余字段，事务内维护，避免 list 时 COUNT(*) 全表扫描） */
    messageCount: integer('message_count').notNull().default(0),
    /** 会话级项目工作目录（绝对路径，agent 工具操作边界） */
    workingDir: text('working_dir').notNull(),
    /** 最近运行状态：idle=空闲，running=进行中，interrupted=异常中断（崩溃恢复识别） */
    lastRunStatus: text('last_run_status').$type<RunStatus>().notNull().default('idle'),
    /** 是否置顶（对齐参考项目 pinned-header 分组；置顶会话优先展示） */
    pinned: integer('pinned').notNull().default(0),
  },
  (t) => [
    // 稳定枚举：运行状态三值恒定，DB 层兜底非法值
    check(
      'chk_sessions_last_run_status',
      sql`${t.lastRunStatus} IN ('idle','running','interrupted')`,
    ),
    // 查询索引：list 接口按 updatedAt 倒序（SQLite 索引可反向扫描，无需显式 DESC）
    index('idx_sessions_updated_at').on(t.updatedAt),
  ],
);

/**
 * messages 表：消息历史
 *
 * 一行对应一条 ModelMessage（user / assistant / tool 等）。
 * content 存储完整 ModelMessage 的 JSON 序列化字符串，
 * 由 SessionService 序列化/反序列化。
 *
 * seq 是消息序号（从 0 递增），同一 sessionId 内唯一递增。
 *
 * turn_id 关联 turns.turnId 但**不加外键**（有意）：
 * 消息在回合进行中即写入（用户消息回合开始落库、助手消息流式落库），
 * 而 turns 行在回合结束（TURN_END）才写入——若加 FK 会在回合未结束时
 * 插入消息即触发外键违规。仅由 turns.turn_id UNIQUE 保证回合行不重复。
 */
export const messages = sqliteTable(
  'messages',
  {
    /** 消息唯一 id（自增，SQLite rowid） */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 所属会话 id（外键关联 sessions.id，级联删除） */
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** 所属回合 id（Transcript 消息级明细；null = 旧数据/未归属回合） */
    turnId: text('turn_id'),
    /** 消息序号（从 0 递增，用于排序） */
    seq: integer('seq').notNull(),
    /** 消息角色（user / assistant / tool / system） */
    role: text('role').$type<MessageRole>().notNull(),
    /** 完整 ModelMessage 的 JSON 序列化字符串 */
    content: text('content').notNull(),
    /** 创建时间（Unix timestamp 毫秒） */
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    // 稳定枚举：消息角色四值恒定
    check('chk_messages_role', sql`${t.role} IN ('user','assistant','tool','system')`),
    // 会话内序号唯一：防并发/重试写入同 seq 产生双行（会话历史错乱的根源）
    // 该 UNIQUE 同时承担"按 sessionId 过滤 + seq 升序"的查询索引职责——
    // drizzle 会把它发成具名 UNIQUE 索引 uq_messages_session_seq，列序 (session_id, seq)
    // 的最左前缀即可服务该查询，故无需再建同列普通索引（只会带来写放大）
    unique('uq_messages_session_seq').on(t.sessionId, t.seq),
    index('idx_messages_turn').on(t.turnId),
  ],
);

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
export const prompts = sqliteTable(
  'prompts',
  {
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
  },
  (t) => [
    // 查询索引：按角色过滤 prompt
    index('idx_prompts_role').on(t.role),
  ],
);

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
export const tokenUsage = sqliteTable(
  'token_usage',
  {
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
  },
  (t) => [
    // 查询索引：用量页按时间窗口聚合
    index('idx_token_usage_created_at').on(t.createdAt),
  ],
);

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
 *
 * turnId UNIQUE：防同一回合因写入重试产生重复行
 * （messages.turn_id 不设外键的原因见 messages 表注释）
 */
export const turns = sqliteTable(
  'turns',
  {
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
    status: text('status').$type<TurnStatus>().notNull(),
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
  },
  (t) => [
    // 唯一：防同一回合重复落库
    unique('uq_turns_turn_id').on(t.turnId),
    // 会话内回合序号唯一：防 transcript 序号重复
    unique('uq_turns_session_seq').on(t.sessionId, t.seq),
    // 查询索引：按会话取回合列表（seq 升序）
    index('idx_turns_session_seq').on(t.sessionId, t.seq),
  ],
);

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
export const runtimeModels = sqliteTable(
  'runtime_models',
  {
    /** 模型 id（主键，全局唯一） */
    modelId: text('model_id').primaryKey(),
    /** 所属供应商 kind（决定 SDK 协议） */
    providerKind: text('provider_kind').notNull(),
    /** 显式 baseUrl（覆盖供应商默认端点；null = 用默认） */
    baseUrl: text('base_url'),
    /** 模型展示名称（自定义模式选填；null = 回退 modelId） */
    displayName: text('display_name'),
    /** 启停状态（0=停用 1=启用；默认启用） */
    isEnabled: integer('is_enabled').$type<0 | 1>().notNull().default(1),
    /** 创建时间（Unix timestamp 毫秒） */
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    // 布尔字段：只允许 0/1
    check('chk_runtime_models_is_enabled', sql`${t.isEnabled} IN (0,1)`),
  ],
);

/**
 * goals 表：会话目标跟踪（对齐 qwen /goal 语义，持久化替代内存态）
 *
 * 设计：
 * - 目标绑定会话（sessionId 外键）；每会话一个 active 目标（新建覆盖旧）
 * - 回合结束后由 GoalService 用 LLM 判定 condition 是否满足（goalJudge）
 * - status：active（进行中）/ completed（判定满足）/ aborted（用户清除）
 */
export const goals = sqliteTable(
  'goals',
  {
    /** 自增主键 */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 所属会话 id（外键关联 sessions.id） */
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** 目标条件描述（用户注册的完成条件） */
    condition: text('condition').notNull(),
    /** 状态：active / completed / aborted */
    status: text('status').$type<GoalStatus>().notNull(),
    /** 已判定回合数 */
    iterations: integer('iterations').notNull().default(0),
    /** 最近一次判定理由（LLM 输出或错误说明） */
    lastReason: text('last_reason'),
    /** 创建时间（Unix timestamp 毫秒） */
    createdAt: integer('created_at').notNull(),
    /** 完成/清除时间（null = 未结束） */
    finishedAt: integer('finished_at'),
  },
  (t) => [
    // 查询索引：按会话取目标
    index('idx_goals_session').on(t.sessionId),
  ],
);

/**
 * tasks 表：任务状态机持久化（对齐 qwen tasks 语义收敛）
 *
 * 设计：
 * - 任务条目（委派工作单元）绑定会话
 * - 内存注册表升级为 sqlite 持久化（重启后任务历史保留）
 * - session_id **不加外键**（有意）：任务可关联任意 id，含子代理内部回合的 sessionId
 */
export const tasks = sqliteTable('tasks', {
  /** 任务 id（uuid 主键） */
  id: text('id').primaryKey(),
  /** 所属会话 id（无外键：任务可关联任意 id，含子代理内部回合 sessionId） */
  sessionId: text('session_id').notNull(),
  /** 任务种类（agent / shell） */
  kind: text('kind').$type<TaskKind>().notNull(),
  /** 人类可读描述 */
  description: text('description').notNull(),
  /** 状态（pending / running / completed / failed / cancelled） */
  status: text('status').$type<TaskStatus>().notNull(),
  /** 创建时间（Unix timestamp 毫秒） */
  startTime: integer('start_time').notNull(),
  /** 结束时间（null = 未结束） */
  endTime: integer('end_time'),
});

/**
 * cron_tasks 表：定时任务（对齐 qwen cronScheduler durable 语义收敛）
 *
 * session_id **不加外键**（有意，与 tasks 表一致）：定时任务可由 agent 工具
 * 在任意会话上下文创建（含子代理内部回合的 sessionId），不保证一定对应
 * sessions 表中的持久会话；加外键会在这些场景触发 FOREIGN KEY 违规。
 */
export const cronTasks = sqliteTable(
  'cron_tasks',
  {
    /** 任务 id（uuid 主键） */
    id: text('id').primaryKey(),
    /** 所属会话 id（无外键：任务可关联任意 id，含子代理内部回合 sessionId） */
    sessionId: text('session_id').notNull(),
    /** cron 表达式（5 字段） */
    expression: text('expression').notNull(),
    /** 任务描述 */
    description: text('description').notNull(),
    /** 下次触发时间（Unix 毫秒；null = 未启用） */
    nextFireAt: integer('next_fire_at'),
    /** 是否启用（0/1） */
    enabled: integer('enabled').$type<0 | 1>().notNull().default(1),
    /** 创建时间 */
    createdAt: integer('created_at').notNull(),
  },
  (t) => [check('chk_cron_tasks_enabled', sql`${t.enabled} IN (0,1)`)],
);

export type CronTaskRow = typeof cronTasks.$inferSelect;

/**
 * skills 表：学习到的技能（learn-skill-agent 产物；source=learned）
 */
export const skills = sqliteTable(
  'skills',
  {
    /** 技能名（snake_case 主键） */
    name: text('name').primaryKey(),
    /** 一句话描述 */
    description: text('description').notNull(),
    /** 技能提示词 */
    prompt: text('prompt').notNull(),
    /** 来源（learned / builtin） */
    source: text('source').$type<SkillSource>().notNull().default('learned'),
    /** 创建时间 */
    createdAt: integer('created_at').notNull(),
  },
  (t) => [check('chk_skills_source', sql`${t.source} IN ('learned','builtin')`)],
);

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

/**
 * app_settings 表：渲染层用户设置（主题/AI/编辑器/快捷键/实验性）
 *
 * S1 设计（settings 下沉 SQLite，用户决策）：
 * - 此前 settings 只活在 renderer localStorage——清缓存即丢、主进程读不到，
 *   且与 SQLite 数据层形成双持久化后端；现收敛为 SQLite 单一真源
 * - key：设置域标识（'theme' / 'ai' / 'editor' / 'shortcuts' / 'experimental'）
 * - value：JSON 字符串（结构由渲染层 settings-store 定义，主进程不解析）
 */
export const appSettings = sqliteTable('app_settings', {
  /** 设置域 key（主键） */
  key: text('key').primaryKey(),
  /** JSON 序列化值 */
  value: text('value').notNull(),
  /** 最后更新时间（Unix 毫秒） */
  updatedAt: integer('updated_at').notNull(),
});

// 导出 schema 对象供 db.ts 创建表
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
