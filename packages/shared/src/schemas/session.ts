// session.ts：会话域 IPC 契约单一真源——会话增删改查 / 回合与用量查询 / 上下文压缩 / 导出导入文件
// 格式的 zod schema 与接口类型。
// 边界：只定义契约（校验 + 默认值），持久化与业务规则在 src/main/infra/storage/session-service.ts；
// 响应 schema 经 IPC 定义表交由 wrap 在 handler 返回值出主进程前复核（防手写 Res 接口漂移）。

import { z } from 'zod';
import type { ChatMessage } from './chat';

// ────────── 会话增删改查：请求 schema 与响应 payload 成对（session 域 IPC 定义表消费） ──────────

/**
 * session:list 入参 zod schema
 *
 * 分页查询：limit 单页数量（默认 50，上限 100），offset 偏移量（默认 0）。
 * 返回顺序：置顶优先，同组内按 updatedAt 倒序（对齐参考项目 pinned 分组）。
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
  /** 会话唯一 id（UUID，由 SessionService.create 生成） */
  id: z.string(),
  /** 会话标题（用户可编辑；默认取首条 user 消息前 50 字符，无则 '新会话'） */
  title: z.string(),
  /** 创建时间（Unix timestamp 毫秒） */
  createdAt: z.number().int(),
  /** 最后更新时间（Unix timestamp 毫秒） */
  updatedAt: z.number().int(),
  // 最后一条 user 消息预览（前 100 字符，列表展示用；无 user 消息时为空）。
  // 用 .optional().transform 而非裸 .optional()：推断结果是「必填属性、值可为 undefined」，
  // 在 exactOptionalPropertyTypes 下可直接喂给 SessionMeta 消费方
  lastMessage: z
    .string()
    .optional()
    .transform((v) => v ?? undefined),
  /** 消息数量（冗余字段，事务内随写入维护，免去 list 时 COUNT(*) 全表扫描） */
  messageCount: z.number().int().nonnegative(),
  /** 会话级项目工作目录（绝对路径；agent 文件类工具的读写边界，越界被 path-guard 拒绝） */
  workingDir: z.string(),
  /** 最近运行状态：idle=空闲，running=进行中，interrupted=未收尾残留（markAllInterrupted 在启动恢复与退出善后落此值） */
  lastRunStatus: z.enum(['idle', 'running', 'interrupted']).default('idle'),
  /** 是否置顶（侧栏置顶分组优先展示） */
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
  /**
   * 是否返回完整消息历史（默认 false：仅元数据，messages 返回空数组）。
   * 渲染层历史走 session:getTurns + session:getTurnMessages 按回合增量拉取
   * （docs/design/debt.md D2），元数据消费方（workingDir/lastRunStatus）不为全量
   * 消息付 IPC 负载；仅显式传 true 的调用方（数据回放/兼容场景）才返回全量消息。
   */
  includeMessages: z.boolean().optional(),
});

/**
 * session:get 响应 payload
 *
 * 返回完整会话元数据 + 完整消息历史（ModelMessage 数组）。
 * messages 的**类型**为 ChatMessage[]（= AI SDK ModelMessage），使渲染层可直接消费、
 * 无需类型断言；**运行时校验**仍为宽松的 z.array(z.unknown())——二者有意分离：
 * 类型声明给消费方准确契约，运行时校验不引入 AI SDK 的 zod 依赖与复杂 union 成本。
 * 具体结构由 AgentService 在写入时保证（ModelMessage[] 序列化）。
 */
export interface SessionGetRes {
  readonly session: SessionMeta;
  /** 完整消息历史（ModelMessage 数组） */
  readonly messages: readonly ChatMessage[];
}

/** session:delete 入参 zod schema */
export const SessionDeleteReqSchema = z.object({
  id: z.string().min(1),
});

/** session:delete 响应 payload */
export interface SessionDeleteRes {
  readonly ok: boolean;
}

/** session:clearAll 入参 zod schema（无入参；36-D 清空全部会话） */
export const SessionClearAllReqSchema = z.object({});

/** session:clearAll 响应 payload（deleted = 真实删除的会话行数） */
export interface SessionClearAllRes {
  readonly deleted: number;
}

/** session:rename 入参 zod schema */
export const SessionRenameReqSchema = z.object({
  id: z.string().min(1),
  // 新标题（上限须与 src/main/infra/storage/session-helpers.ts 的 TITLE_MAX_LENGTH 保持一致）
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
  // 项目工作目录（绝对路径，agent 工具操作边界）
  workingDir: z.string().min(1),
  // 可选标题；省略时由 SessionService 按「首条 user 消息前 50 字符 → '新会话'」派生
  title: z.string().min(1).max(100).optional(),
});

/** session:create 响应 payload */
export interface SessionCreateRes {
  readonly sessionId: string;
}

// ────────── 用量统计（session:getUsageSummary，设置页展示） ──────────

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
  /** 按日分组（近 90 天，倒序；窗口口径见 src/main/infra/storage/usage-turn-store.ts） */
  readonly byDay: readonly UsageDaySummary[];
}

// ────────── 回合查询（Transcript / 设置页回合记录） ──────────

/**
 * 回合摘要（session:getTurns 响应条目，Transcript 查询结果）
 */
export interface TurnSummary {
  /** 回合唯一 id（关联 TurnEvent.turnId） */
  readonly turnId: string;
  /** 回合序号（会话内递增） */
  readonly seq: number;
  readonly modelId: string;
  /**
   * 终止原因：
   * - 'completed'：正常跑完
   * - 'aborted'：用户主动中断
   * - 'max-steps'：达单回合工具调用轮数上限而收束
   * - 'error'：异常结束（通知分组上 aborted/max-steps 属「非错误终止」，仅 error 走失败通知）
   */
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
  limit: z.number().int().positive().max(50).default(10),
});

/** session:listRecentDirs 入参 zod schema */
export const SessionListRecentDirsReqSchema = z.object({
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
  readonly messages: readonly ChatMessage[];
}

// ────────── 响应契约 zod schema：与上方各 Res 接口手工同步，防 handler 返回结构漂移 ──────────

/** session:get 响应 schema */
export const SessionGetResSchema = z.object({
  session: SessionMetaSchema,
  messages: z.array(z.unknown()),
});

/** session:delete 响应 schema */
export const SessionDeleteResSchema = z.object({
  ok: z.boolean(),
});

/** session:clearAll 响应 schema（36-D：deleted = 真实删除的会话行数） */
export const SessionClearAllResSchema = z.object({
  deleted: z.number().int().nonnegative(),
});

/** session:rename 响应 schema */
export const SessionRenameResSchema = z.object({
  ok: z.boolean(),
});

/** session:pin 响应 schema */
export const SessionPinResSchema = z.object({
  ok: z.boolean(),
});

/** session:create 响应 schema */
export const SessionCreateResSchema = z.object({
  sessionId: z.string().min(1),
});

/** 用量模型汇总 schema */
export const UsageModelSummarySchema = z.object({
  modelId: z.string(),
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
});

/** 用量按日汇总 schema */
export const UsageDaySummarySchema = z.object({
  date: z.string(),
  calls: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

/** session:getUsageSummary 响应 schema */
export const UsageSummaryResSchema = z.object({
  total: z.object({
    calls: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  }),
  byModel: z.array(UsageModelSummarySchema),
  byDay: z.array(UsageDaySummarySchema),
});

/** 回合摘要 schema（字段与 TurnSummary 手工同步；可选数值列在 DB 为 null → undefined） */
export const TurnSummarySchema = z.object({
  turnId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  modelId: z.string(),
  status: z.enum(['completed', 'aborted', 'max-steps', 'error']),
  // 四个 optional + transform：DB 列为 nullable，导出/查询侧统一写 undefined 表示「无值」，
  // 推断结果「必填属性、值可为 undefined」在 exactOptionalPropertyTypes 下可直接喂给消费方
  inputTokens: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .transform((v) => v ?? undefined),
  outputTokens: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .transform((v) => v ?? undefined),
  totalTokens: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .transform((v) => v ?? undefined),
  durationMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .transform((v) => v ?? undefined),
  createdAt: z.number().int(),
});

/** session:getTurns 响应 schema */
export const SessionGetTurnsResSchema = z.object({
  sessionId: z.string().min(1),
  turns: z.array(TurnSummarySchema),
});

/** session:getRecentTurns 响应 schema */
export const SessionRecentTurnsResSchema = z.object({
  turns: z.array(TurnSummarySchema.extend({ sessionId: z.string() })),
});

/** session:listRecentDirs 响应 schema */
export const SessionListRecentDirsResSchema = z.object({
  dirs: z.array(
    z.object({
      workingDir: z.string().min(1),
      lastUsed: z.number().int(),
    }),
  ),
});

/** session:getTurnMessages 响应 schema */
export const SessionGetTurnMessagesResSchema = z.object({
  messages: z.array(z.unknown()),
});

// ────────── 上下文压缩（session:compact，/compact 斜杠命令入口） ──────────

/** session:compact 入参 schema */
export const SessionCompactReqSchema = z.object({
  sessionId: z.string().min(1),
});

/** session:compact 响应 payload */
export interface SessionCompactRes {
  /** 被整条丢弃的消息条数（就地裁剪不计入） */
  readonly removed: number;
  /** 压缩后剩余消息条数 */
  readonly remaining: number;
  /** 回收的 token 数（含就地裁剪；0 = 已在预算内，主进程据此决定是否写库） */
  readonly reclaimedTokens: number;
  /** 压缩后的全量消息历史（渲染层 setMessages 整体替换本地态） */
  readonly messages: readonly ChatMessage[];
}

/** session:compact 响应 schema（reclaimedTokens=0 表示已无需压缩；messages 为压缩后全量历史） */
export const SessionCompactResSchema = z.object({
  removed: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  reclaimedTokens: z.number().int().nonnegative(),
  messages: z.array(z.unknown()),
});

// ────────── 会话导出文件格式（版本化，数据资产可迁移） ──────────
// SessionExportFileSchema 是导出文件的唯一契约真源：导出侧（SessionService.exportAll）
// 按它产出，导入侧（session:import）按它校验——仅接受当前版本，无野外旧格式兼容。

/** 当前会话导出文件格式版本（导入侧仅接受本版本，用于 version 字面量校验） */
export const SESSION_EXPORT_VERSION = 1;

/**
 * 导出消息条目（messages 表行对称）
 *
 * content 为完整 ModelMessage 的 JSON 值（导出侧 JSON.parse 后嵌入；
 * DB 内容损坏无法解析时保留原始字符串，导入侧原样回写不二次编码）。
 * turnId 归属回合 id（与 messages.turn_id 对称；缺失 = 未归属回合：压缩后的
 * 旧上下文与历史数据均无归属）。
 */
export const SessionExportMessageSchema = z.object({
  seq: z.number().int().nonnegative(),
  turnId: z.string().min(1).optional(),
  content: z.unknown(),
  createdAt: z.number().int(),
});

/** 导出消息条目类型 */
export type SessionExportMessage = z.infer<typeof SessionExportMessageSchema>;

/**
 * 导出 token 用量条目（token_usage 表行对称，sessionId 由外层会话提供）
 */
export const SessionExportUsageSchema = z.object({
  modelId: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cacheReadTokens: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .transform((v) => v ?? undefined),
  reasoningTokens: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .transform((v) => v ?? undefined),
  createdAt: z.number().int(),
});

/** 导出 token 用量条目类型 */
export type SessionExportUsage = z.infer<typeof SessionExportUsageSchema>;

/**
 * 导出单个会话（元数据 + 消息 + 回合 + 用量）
 *
 * turns 复用 TurnSummarySchema（turns 表行对称，sessionId 由外层会话提供）。
 */
export const SessionExportItemSchema = z.object({
  meta: SessionMetaSchema,
  messages: z.array(SessionExportMessageSchema),
  turns: z.array(TurnSummarySchema),
  usage: z.array(SessionExportUsageSchema),
});

/** 导出单个会话类型 */
export type SessionExportItemShape = z.infer<typeof SessionExportItemSchema>;

/**
 * 会话导出文件 schema（version=1）
 *
 * 导出侧输出与导入侧校验共用：导入只接受带本版本标记的文件（首次版本化，
 * 无历史野外格式需要兼容）；version 不匹配 → INVALID_INPUT 拒绝导入。
 */
export const SessionExportFileSchema = z.object({
  version: z.literal(SESSION_EXPORT_VERSION),
  exportedAt: z.number().int(),
  app: z.string(),
  sessions: z.array(SessionExportItemSchema),
});

/** 会话导出文件类型 */
export type SessionExportFile = z.infer<typeof SessionExportFileSchema>;

/** session:import 响应 payload（imported = 新增会话数；skipped = 同 id 已存在跳过数） */
export interface SessionImportRes {
  readonly imported: number;
  readonly skipped: number;
}

/** session:import 响应 zod schema（响应契约校验用） */
export const SessionImportResSchema = z.object({
  imported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
