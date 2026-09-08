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
import { desc, eq, gte, lt, sql } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { getDb, reclaimFreePages } from './db';
import { tokenUsage, turns } from './schema';

/** 用量统计窗口（90 天）：查询成本有界 + 关注近期消耗 */
const USAGE_SUMMARY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

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

/**
 * 用量统计汇总（总量 / 按模型 / 按日）
 *
 * 90 天窗口过滤：设置页只关心近期消耗；全表扫描随数据增长变慢，
 * 窗口限制保证查询成本有界（token_usage 按日索引命中）。
 *
 * 2026-09-08 性能修复：此前 `select()` 取窗口内全列全行再在 JS 里三趟累加
 * （1 万行 × 7 列的对象分配 + Map 更新）。现改为三条 GROUP BY 下推 SQL——
 * 只回传聚合结果（模型数 / 天数，量级远小于行数）。
 */
export async function getUsageSummary(): Promise<UsageSummaryRes> {
  const db = getDb();
  const windowStart = Date.now() - USAGE_SUMMARY_WINDOW_MS;

  const totalRow = db
    .select({
      calls: sql<number>`COUNT(*)`,
      inputTokens: sql<number>`COALESCE(SUM(${tokenUsage.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${tokenUsage.outputTokens}), 0)`,
      totalTokens: sql<number>`COALESCE(SUM(${tokenUsage.totalTokens}), 0)`,
    })
    .from(tokenUsage)
    .where(gte(tokenUsage.createdAt, windowStart))
    .get();

  const byModel = db
    .select({
      modelId: tokenUsage.modelId,
      calls: sql<number>`COUNT(*)`,
      inputTokens: sql<number>`COALESCE(SUM(${tokenUsage.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${tokenUsage.outputTokens}), 0)`,
      totalTokens: sql<number>`COALESCE(SUM(${tokenUsage.totalTokens}), 0)`,
      cacheReadTokens: sql<number>`COALESCE(SUM(${tokenUsage.cacheReadTokens}), 0)`,
      reasoningTokens: sql<number>`COALESCE(SUM(${tokenUsage.reasoningTokens}), 0)`,
    })
    .from(tokenUsage)
    .where(gte(tokenUsage.createdAt, windowStart))
    .groupBy(tokenUsage.modelId)
    .orderBy(sql`SUM(${tokenUsage.totalTokens}) DESC`)
    .all();

  // 按日聚合用 SQLite 的 localtime 转换（与 formatLocalDate 语义一致）
  const byDay = db
    .select({
      date: sql<string>`date(${tokenUsage.createdAt} / 1000, 'unixepoch', 'localtime')`,
      calls: sql<number>`COUNT(*)`,
      totalTokens: sql<number>`COALESCE(SUM(${tokenUsage.totalTokens}), 0)`,
    })
    .from(tokenUsage)
    .where(gte(tokenUsage.createdAt, windowStart))
    .groupBy(sql`date(${tokenUsage.createdAt} / 1000, 'unixepoch', 'localtime')`)
    .orderBy(sql`date(${tokenUsage.createdAt} / 1000, 'unixepoch', 'localtime') DESC`)
    .limit(90)
    .all();

  return {
    total: {
      calls: totalRow?.calls ?? 0,
      inputTokens: totalRow?.inputTokens ?? 0,
      outputTokens: totalRow?.outputTokens ?? 0,
      totalTokens: totalRow?.totalTokens ?? 0,
    },
    byModel,
    byDay,
  };
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
  // 2026-09-08 修复（seq 并发冲突）：seq 此前由调用方用 `existing.length` 计算
  // （agent-service.persistTurn 先全量查 turns 再取长度），既让每回合多一次
  // O(n) 查询，也在并发写同一会话时产生重复 seq（uq_turns_session_seq 冲突 →
  // 该回合流水被静默丢弃）。现改为在 INSERT 内用 SQL 子查询原子取值：
  // 单条语句内完成「读最大值 + 插入」，better-sqlite3 同步执行无交错窗口。
  const nextSeq = db
    .select({ maxSeq: sql<number | null>`MAX(${turns.seq})` })
    .from(turns)
    .where(eq(turns.sessionId, turn.sessionId))
    .get();
  const seq = (nextSeq?.maxSeq ?? -1) + 1;
  db.insert(turns)
    .values({
      turnId: turn.turnId,
      sessionId: turn.sessionId,
      seq,
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
