// usage-turn-store.ts：用量与回合的存储层（session-service 委托到这里，文件级拆分控体量）
// 写入路径 token_usage 按统计窗口滚动清理，表不会无限膨胀
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

// 统计窗口 90 天：summary/清理共用同一窗口（超出即清，图表最多也只画 90 天）
const USAGE_SUMMARY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** 清理窗口外的 token_usage 行；@returns 清理行数 */
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

/** 追加一条用量流水（每模型请求一条；缓存读/推理 token 可缺省） */
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
      ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
      createdAt: Date.now(),
    })
    .run();
}

/** 用量汇总：总量 + 按模型 + 按日（本地时区）三视图，全部限统计窗口 */
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

/** 回合落库：seq 取会话内当前 MAX+1（服务层保证回合不并发，此处不再加锁） */
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
      ...(turn.inputTokens !== undefined ? { inputTokens: turn.inputTokens } : {}),
      ...(turn.outputTokens !== undefined ? { outputTokens: turn.outputTokens } : {}),
      ...(turn.totalTokens !== undefined ? { totalTokens: turn.totalTokens } : {}),
      ...(turn.durationMs !== undefined ? { durationMs: turn.durationMs } : {}),
      createdAt: Date.now(),
    })
    .run();
}

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

export async function getRecentTurns(req: {
  readonly limit: number;
}): Promise<SessionRecentTurnsRes> {
  const db = getDb();
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
