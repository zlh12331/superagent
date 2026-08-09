// packages/shared/src/schemas/session.ts
// 会话域 zod schema 单一真源
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义 session:list / get / delete / rename 请求-响应 zod schema
// - 供主进程 SessionService 校验入参
//
// 设计：
// - SessionService 基于 better-sqlite3 + drizzle-orm 持久化
// - 表结构：sessions（会话元数据）/ messages（消息历史）/ tool_calls（工具调用记录）
// - messages 字段为 JSON 数组（完整 ModelMessage 历史），由主进程序列化/反序列化
// - SessionMetaSchema 是会话元数据，list 接口返回，不包含完整消息历史
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/**
 * session:list 入参 zod schema
 *
 * 分页查询：limit 单页数量（默认 50，上限 100），offset 偏移量（默认 0）。
 * 返回按 updatedAt 倒序排列的会话列表。
 */
export const SessionListReqSchema = z.object({
  limit: z.number().int().positive().max(100).default(50),
  offset: z.number().int().nonnegative().default(0),
});

/**
 * 会话元数据 zod schema
 *
 * 不包含完整消息历史，仅用于会话列表展示。
 * 完整历史通过 session:get 获取。
 */
export const SessionMetaSchema = z.object({
  // 会话唯一 id（UUID）
  id: z.string(),
  // 会话标题（用户可编辑，默认取首条用户消息前 50 字符）
  title: z.string(),
  // 创建时间（Unix timestamp 毫秒）
  createdAt: z.number().int(),
  // 最后更新时间（Unix timestamp 毫秒）
  updatedAt: z.number().int(),
  // 最后一条用户消息预览（前 100 字符，用于列表展示）
  lastMessage: z
    .string()
    .optional()
    .transform((v) => v ?? undefined),
  // 消息数量
  messageCount: z.number().int().nonnegative(),
  // 会话级项目工作目录（绝对路径，agent 工具操作边界）
  workingDir: z.string(),
  // 最近运行状态：idle=空闲，running=进行中，interrupted=异常中断（崩溃恢复识别）
  lastRunStatus: z.enum(['idle', 'running', 'interrupted']).default('idle'),
  // 是否置顶（对齐参考项目 pinned-header 分组）
  pinned: z.boolean().default(false),
});

/** 会话元数据类型 */
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

/** session:list 响应 payload */
export interface SessionListRes {
  readonly sessions: readonly SessionMeta[];
  /** 会话总数（用于分页计算） */
  readonly total: number;
}

/** session:list 响应 zod schema（响应契约校验用） */
export const SessionListResSchema = z.object({
  sessions: z.array(SessionMetaSchema),
  total: z.number().int().nonnegative(),
});

/** session:get 入参 zod schema */
export const SessionGetReqSchema = z.object({
  id: z.string().min(1),
});

/**
 * session:get 响应 payload
 *
 * 返回完整会话元数据 + 完整消息历史（ModelMessage 数组）。
 * messages 字段类型为 unknown[]：主进程从 SQLite 读出 JSON 字符串后解析，
 * 具体结构由 AgentService 在写入时保证（ModelMessage[] 序列化）。
 */
export interface SessionGetRes {
  readonly session: SessionMeta;
  /** 完整消息历史（ModelMessage 数组） */
  readonly messages: readonly unknown[];
}

/** session:delete 入参 zod schema */
export const SessionDeleteReqSchema = z.object({
  id: z.string().min(1),
});

/** session:delete 响应 payload */
export interface SessionDeleteRes {
  readonly ok: boolean;
}

/** session:rename 入参 zod schema */
export const SessionRenameReqSchema = z.object({
  id: z.string().min(1),
  // 新标题（1-100 字符）
  title: z.string().min(1).max(100),
});

/** session:rename 响应 payload */
export interface SessionRenameRes {
  readonly ok: boolean;
}

/** session:pin 入参 zod schema（置顶/取消置顶；对齐参考项目 pinned 分组） */
export const SessionPinReqSchema = z.object({
  id: z.string().min(1),
  pinned: z.boolean(),
});

/** session:pin 响应 payload */
export interface SessionPinRes {
  readonly ok: boolean;
}

/** session:create 入参 zod schema */
export const SessionCreateReqSchema = z.object({
  // 项目工作目录（绝对路径，非空字符串）
  workingDir: z.string().min(1),
  // 可选标题（省略时由 SessionService 自动生成）
  title: z.string().min(1).max(100).optional(),
});

/** session:create 响应 payload */
export interface SessionCreateRes {
  readonly sessionId: string;
}

/**
 * 单模型用量汇总（session:getUsageSummary 响应 byModel 条目）
 */
export interface UsageModelSummary {
  readonly modelId: string;
  /** 调用次数 */
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** KV cache 命中 token（DeepSeek 计费优化可见性） */
  readonly cacheReadTokens: number;
  /** 思维链 token（reasoning 模型） */
  readonly reasoningTokens: number;
}

/**
 * 按日用量条目（session:getUsageSummary 响应 byDay）
 */
export interface UsageDaySummary {
  /** 日期（YYYY-MM-DD，本地时区） */
  readonly date: string;
  readonly calls: number;
  readonly totalTokens: number;
}

/**
 * session:getUsageSummary 响应 payload（设置页用量统计）
 */
export interface UsageSummaryRes {
  /** 总量汇总 */
  readonly total: {
    readonly calls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
  /** 按模型分组 */
  readonly byModel: readonly UsageModelSummary[];
  /** 按日分组（近 30 天，倒序） */
  readonly byDay: readonly UsageDaySummary[];
}

/**
 * 回合摘要（session:getTurns 响应条目，Transcript 查询结果）
 */
export interface TurnSummary {
  /** 回合唯一 id（关联 TurnEvent.turnId） */
  readonly turnId: string;
  /** 回合序号（会话内递增） */
  readonly seq: number;
  readonly modelId: string;
  /** 终止原因 */
  readonly status: 'completed' | 'aborted' | 'max-steps' | 'error';
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly totalTokens: number | undefined;
  /** 回合总耗时（毫秒） */
  readonly durationMs: number | undefined;
  readonly createdAt: number;
}

/**
 * 回合终止原因 → 展示文案映射（渲染层用）
 */
export type TurnStatusText = Record<TurnSummary['status'], string>;

/**
 * session:getTurns 响应 payload（回合级查询）
 */
export interface SessionGetTurnsRes {
  readonly sessionId: string;
  /** 按 seq 升序的回合列表 */
  readonly turns: readonly TurnSummary[];
}

/** session:getTurns 入参 zod schema */
export const SessionGetTurnsReqSchema = z.object({
  sessionId: z.string().min(1),
});

/**
 * session:getRecentTurns 响应 payload（设置页回合记录展示）
 */
export interface SessionRecentTurnsRes {
  /** 按 createdAt 倒序的最近回合（跨会话） */
  readonly turns: readonly (TurnSummary & { readonly sessionId: string })[];
}

/** session:getRecentTurns 入参 zod schema */
export const SessionGetRecentTurnsReqSchema = z.object({
  // 返回条数上限（默认 10，上限 50）
  limit: z.number().int().positive().max(50).default(10),
});

/** session:listRecentDirs 入参 zod schema */
export const SessionListRecentDirsReqSchema = z.object({
  // 返回条数上限（默认 10，上限 50）
  limit: z.number().int().positive().max(50).default(10),
});

/** 最近目录列表单项 */
export interface RecentDir {
  /** 项目工作目录（绝对路径） */
  readonly workingDir: string;
  /** 最后使用时间（Unix timestamp 毫秒） */
  readonly lastUsed: number;
}

/** session:listRecentDirs 响应 payload */
export interface SessionListRecentDirsRes {
  readonly dirs: readonly RecentDir[];
}

/**
 * session:getTurnMessages 入参 zod schema（Transcript 消息级明细）
 */
export const SessionGetTurnMessagesReqSchema = z.object({
  /** 回合 id（turns.turn_id） */
  turnId: z.string().min(1).max(64),
});

/** session:getTurnMessages 响应 payload（该回合消息明细，按 seq 升序） */
export interface SessionGetTurnMessagesRes {
  readonly messages: readonly unknown[];
}
