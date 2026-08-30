// src/main/infra/storage/usage-turn-store.ts
// LLM 用量与回合流水的存储层（token_usage / turns 两张表）
// ──────────────────────────────────────────────────────────────
// 职责：
// - token_usage：单次 LLM 调用用量写入、90 天窗口汇总、过期清理
// - turns：回合流水写入与查询（会话内按 seq / 跨会话按 createdAt）
//
// 设计：
// - 与 session-service 分离：这两张表的读写不依赖 sessions 行类型，聚合逻辑自成一块
// - better-sqlite3 同步驱动，方法保持 async 以对齐 ISessionService 契约
// ──────────────────────────────────────────────────────────────

import type {
  SessionGetTurnsRes,
  SessionRecentTurnsRes,
  TurnSummary,
  UsageSummaryRes,
} from '@code-agent/shared/main';
import { desc, eq, gte, lt } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { getDb, reclaimFreePages } from './db';
import { tokenUsage, turns } from './schema';

/** 用量统计窗口（90 天）：查询成本有界 + 关注近期消耗 */
const USAGE_SUMMARY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * 时间戳 → 本地时区日期（YYYY-MM-DD，用量按日聚合用）
 */
function formatLocalDate(timestamp: number): string {
  const d = new Date(timestamp);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * 清理统计窗口之外的 token_usage 行（启动时调用）
 *
 * 窗口外的行永远不会进入 getUsageSummary 的结果，留着只会让库文件单调增长。
 * 批量删除后页只进 freelist，不回收则库文件永久停在历史高水位。
 *
 * @returns 被删除的行数
 */
export function pruneExpiredUsage(): number {
  const db = getDb();
  const cutoff = Date.now() - USAGE_SUMMARY_WINDOW_MS;
  const result = db.delete(tokenUsage).where(lt(tokenUsage.createdAt, cutoff)).run();
  if (result.changes > 0) {
    logger.info({ removed: result.changes }, '已清理统计窗口外的 token_usage 行');
    reclaimFreePages();
  }
  return result.changes;
}

/**
 * 记录一次 LLM 调用用量（agent/chat 回合结束时写入一行）
 */
export async function recordUsage(usage: {
  readonly sessionId: string;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens: number | undefined;
  readonly reasoningTokens: number | undefined;
}): Promise<void> {
  const db = getDb();
  db.insert(tokenUsage)
    .values({
      sessionId: usage.sessionId,
      modelId: usage.modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      // exactOptionalPropertyTypes：可空列 undefined 时条件展开
      ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
      createdAt: Date.now(),
    })
    .run();
}

/** token_usage 行（聚合输入，类型直接由 schema 推导） */
type UsageRow = typeof tokenUsage.$inferSelect;

/** 按模型聚合中间态（可变，避免触碰 readonly 接口字段） */
type MutableModelSummary = {
  modelId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
};

/** 按日聚合中间态 */
type MutableDaySummary = { date: string; calls: number; totalTokens: number };

/** 累加单个模型的用量（map 原地更新） */
function bumpModel(map: Map<string, MutableModelSummary>, row: UsageRow): void {
  const model = map.get(row.modelId) ?? {
    modelId: row.modelId,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  };
  model.calls += 1;
  model.inputTokens += row.inputTokens;
  model.outputTokens += row.outputTokens;
  model.totalTokens += row.totalTokens;
  model.cacheReadTokens += row.cacheReadTokens ?? 0;
  model.reasoningTokens += row.reasoningTokens ?? 0;
  map.set(row.modelId, model);
}

/** 累加单日（本地时区）的用量（map 原地更新） */
function bumpDay(map: Map<string, MutableDaySummary>, row: UsageRow): void {
  const date = formatLocalDate(row.createdAt);
  const day = map.get(date) ?? { date, calls: 0, totalTokens: 0 };
  day.calls += 1;
  day.totalTokens += row.totalTokens;
  map.set(date, day);
}

/** 单趟扫描聚合出总量 / 按模型 / 按日三组结果 */
function aggregateUsage(rows: readonly UsageRow[]): UsageSummaryRes {
  const total = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const byModelMap = new Map<string, MutableModelSummary>();
  const byDayMap = new Map<string, MutableDaySummary>();
  for (const row of rows) {
    total.calls += 1;
    total.inputTokens += row.inputTokens;
    total.outputTokens += row.outputTokens;
    total.totalTokens += row.totalTokens;
    bumpModel(byModelMap, row);
    bumpDay(byDayMap, row);
  }
  // 按模型用量倒序、按日倒序（近 90 天，热力图数据源）
  const byModel = [...byModelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  const byDay = [...byDayMap.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 90);
  return { total, byModel, byDay };
}

/**
 * 用量统计汇总（总量 / 按模型 / 按日）
 *
 * 90 天窗口过滤：设置页只关心近期消耗；全表扫描随数据增长变慢，
 * 窗口限制保证查询成本有界（token_usage 按日索引命中）
 */
export async function getUsageSummary(): Promise<UsageSummaryRes> {
  const db = getDb();
  const windowStart = Date.now() - USAGE_SUMMARY_WINDOW_MS;
  const rows = db
    .select()
    .from(tokenUsage)
    .where(gte(tokenUsage.createdAt, windowStart))
    .orderBy(desc(tokenUsage.createdAt))
    .all();
  return aggregateUsage(rows);
}

/**
 * 记录一个回合（agent:run 结束后写入一行）
 */
export async function recordTurn(turn: {
  readonly turnId: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly modelId: string;
  readonly status: 'completed' | 'aborted' | 'max-steps' | 'error';
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly totalTokens: number | undefined;
  readonly durationMs: number | undefined;
}): Promise<void> {
  const db = getDb();
  db.insert(turns)
    .values({
      turnId: turn.turnId,
      sessionId: turn.sessionId,
      seq: turn.seq,
      modelId: turn.modelId,
      status: turn.status,
      // exactOptionalPropertyTypes：可空列 undefined 时条件展开
      ...(turn.inputTokens !== undefined ? { inputTokens: turn.inputTokens } : {}),
      ...(turn.outputTokens !== undefined ? { outputTokens: turn.outputTokens } : {}),
      ...(turn.totalTokens !== undefined ? { totalTokens: turn.totalTokens } : {}),
      ...(turn.durationMs !== undefined ? { durationMs: turn.durationMs } : {}),
      createdAt: Date.now(),
    })
    .run();
}

/**
 * 查询会话的回合列表（按 seq 升序，Transcript 查询）
 */
export async function getTurns(sessionId: string): Promise<SessionGetTurnsRes> {
  const db = getDb();
  const rows = db
    .select()
    .from(turns)
    .where(eq(turns.sessionId, sessionId))
    .orderBy(turns.seq)
    .all();
  const summaries: TurnSummary[] = rows.map((row) => ({
    turnId: row.turnId,
    seq: row.seq,
    modelId: row.modelId,
    status: row.status as TurnSummary['status'],
    inputTokens: row.inputTokens ?? undefined,
    outputTokens: row.outputTokens ?? undefined,
    totalTokens: row.totalTokens ?? undefined,
    durationMs: row.durationMs ?? undefined,
    createdAt: row.createdAt,
  }));
  return { sessionId, turns: summaries };
}

/**
 * 查询最近回合（跨会话，按 createdAt 倒序，设置页展示）
 */
export async function getRecentTurns(req: {
  readonly limit: number;
}): Promise<SessionRecentTurnsRes> {
  const db = getDb();
  // createdAt 同毫秒时按 id 倒序兜底（后写入的排前），保证排序稳定
  const rows = db
    .select()
    .from(turns)
    .orderBy(desc(turns.createdAt), desc(turns.id))
    .limit(req.limit)
    .all();
  const summaries = rows.map((row) => ({
    turnId: row.turnId,
    sessionId: row.sessionId,
    seq: row.seq,
    modelId: row.modelId,
    status: row.status as TurnSummary['status'],
    inputTokens: row.inputTokens ?? undefined,
    outputTokens: row.outputTokens ?? undefined,
    totalTokens: row.totalTokens ?? undefined,
    durationMs: row.durationMs ?? undefined,
    createdAt: row.createdAt,
  }));
  return { turns: summaries };
}
