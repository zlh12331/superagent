// src/main/infra/storage/session-io.ts
// 会话导出/导入的存储层（SessionExportFile v1 文件格式 ↔ SQLite 四表）
// ──────────────────────────────────────────────────────────────
// 职责（自 session-service.ts 提取，SessionService 委托至此，文件大小棘轮考量）：
// - exportAllSessions：聚合 sessions / messages / turns / token_usage → 版本化 payload
// - importSessionsFromPayload：zod 校验 → 同 id 跳过 → 每会话事务落库
//
// 数据完整性设计：
// - 每会话一个事务：单会话失败只回滚该会话，绝不产生"半截会话"（有 sessions 行
//   无 messages 行之类）；其余会话不受影响
// - 导入幂等：同 id 会话整体跳过并计数——同一文件重复导入结果为全 skipped，
//   不会触发 uq_messages_session_seq / uq_turns_turn_id 唯一约束冲突
// - uq_turns_turn_id 是全局唯一（跨会话），文件内两个会话携带同 turnId 时按
//   "先到先得"跳过后到者（记 warn），不使整个会话失败
// - messages 的 role 列有 CHECK 约束且 NOT NULL：无法解析出合法 role 的损坏
//   消息跳过（记 warn），不阻断会话导入
// ──────────────────────────────────────────────────────────────

import type { SessionImportRes, TurnSummary } from '@code-agent/shared/main';
import {
  AppError,
  ErrorCode,
  SESSION_EXPORT_VERSION,
  SessionExportFileSchema,
  type SessionExportItemShape,
  type SessionExportMessage,
  type SessionExportUsage,
} from '@code-agent/shared/main';
import { desc, eq, inArray } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { getDb } from './db';
import {
  type MessageInsert,
  type MessageRole,
  type MessageRow,
  messages,
  type SessionInsert,
  sessions,
  type TokenUsageInsert,
  type TokenUsageRow,
  type TurnInsert,
  type TurnRow,
  tokenUsage,
  turns,
} from './schema';
import { rowToMeta } from './session-helpers';
import type { SessionExportPayload } from './session-types';

/** 导出侧 app 标识（文件头字段，供人工辨认来源） */
const EXPORT_APP_ID = 'code-agent-desktop';

/** 分批 IN 查询的会话 id 上限（远低于 SQLite 变量上限，防 SQLITE_MAX_VARIABLE_NUMBER） */
const EXPORT_BATCH_SIZE = 500;

/**
 * 导出全部会话（元数据 + 消息 + 回合 + token 用量），输出 version=1 文件格式
 *
 * P2-29（自 session-service 内联实现移植）：原实现每会话三条查询（N+1，重度
 * 使用时数千次查询）；改为按会话 id 分批 IN 查询 + 内存分组。sessions 一次
 * 查询按 updatedAt 倒序；messages/turns/token_usage 各按批分片拉取（批内
 * ORDER BY 保证组内相对顺序），SQLITE 变量上限由 EXPORT_BATCH_SIZE 防住。
 *
 * 消息 content 为 JSON.parse 后的 ModelMessage 值；DB 内容损坏无法解析时
 * 保留原始字符串（导出不丢数据），导入侧对该形态原样回写（见 resolveMessageInserts）。
 */
export async function exportAllSessions(): Promise<SessionExportPayload> {
  const db = getDb();
  const rows = db.select().from(sessions).orderBy(desc(sessions.updatedAt)).all();
  // 分批 IN 拉取三类子行并按会话分组（批内 ORDER BY 保证组内升序）
  const messagesBySession = new Map<string, MessageRow[]>();
  const turnsBySession = new Map<string, TurnRow[]>();
  const usageBySession = new Map<string, TokenUsageRow[]>();
  for (let i = 0; i < rows.length; i += EXPORT_BATCH_SIZE) {
    const batchIds = rows.slice(i, i + EXPORT_BATCH_SIZE).map((row) => row.id);
    const messageRows = db
      .select()
      .from(messages)
      .where(inArray(messages.sessionId, batchIds))
      .orderBy(messages.seq)
      .all();
    for (const messageRow of messageRows) {
      const group = messagesBySession.get(messageRow.sessionId);
      if (group !== undefined) {
        group.push(messageRow);
      } else {
        messagesBySession.set(messageRow.sessionId, [messageRow]);
      }
    }
    const turnRows = db
      .select()
      .from(turns)
      .where(inArray(turns.sessionId, batchIds))
      .orderBy(turns.seq)
      .all();
    for (const turnRow of turnRows) {
      const group = turnsBySession.get(turnRow.sessionId);
      if (group !== undefined) {
        group.push(turnRow);
      } else {
        turnsBySession.set(turnRow.sessionId, [turnRow]);
      }
    }
    const usageRows = db
      .select()
      .from(tokenUsage)
      .where(inArray(tokenUsage.sessionId, batchIds))
      .orderBy(tokenUsage.createdAt)
      .all();
    for (const usageRow of usageRows) {
      const group = usageBySession.get(usageRow.sessionId);
      if (group !== undefined) {
        group.push(usageRow);
      } else {
        usageBySession.set(usageRow.sessionId, [usageRow]);
      }
    }
  }
  const items = rows.map((row) => {
    return {
      meta: rowToMeta(row),
      messages: (messagesBySession.get(row.id) ?? []).map(toExportMessage),
      turns: (turnsBySession.get(row.id) ?? []).map(toExportTurn),
      usage: (usageBySession.get(row.id) ?? []).map(toExportUsage),
    };
  });
  return {
    version: SESSION_EXPORT_VERSION,
    exportedAt: Date.now(),
    app: EXPORT_APP_ID,
    sessions: items,
  };
}

/** messages 行 → 导出消息条目（seq/turnId/createdAt 全量保留，round-trip 无损） */
function toExportMessage(row: MessageRow): SessionExportMessage {
  let content: unknown;
  try {
    content = JSON.parse(row.content);
  } catch {
    // 损坏的 content 保留原始字符串（导出不丢数据）
    content = row.content;
  }
  return {
    seq: row.seq,
    // exactOptionalPropertyTypes：未归属回合（NULL）时不携带该字段
    ...(row.turnId !== null ? { turnId: row.turnId } : {}),
    content,
    createdAt: row.createdAt,
  };
}

/** turns 行 → 导出回合条目（TurnSummary 形态，sessionId 由外层会话提供） */
function toExportTurn(row: TurnRow): TurnSummary {
  return {
    turnId: row.turnId,
    seq: row.seq,
    modelId: row.modelId,
    status: row.status,
    inputTokens: row.inputTokens ?? undefined,
    outputTokens: row.outputTokens ?? undefined,
    totalTokens: row.totalTokens ?? undefined,
    durationMs: row.durationMs ?? undefined,
    createdAt: row.createdAt,
  };
}

/** token_usage 行 → 导出用量条目 */
function toExportUsage(row: TokenUsageRow): SessionExportUsage {
  return {
    modelId: row.modelId,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    cacheReadTokens: row.cacheReadTokens ?? undefined,
    reasoningTokens: row.reasoningTokens ?? undefined,
    createdAt: row.createdAt,
  };
}

/**
 * 导入会话（只接受 version=1 导出文件格式）
 *
 * 冲突策略：同 id 会话已存在则整体跳过并计数（不合并、不覆盖）。
 *
 * @throws AppError(INVALID_INPUT) 文件格式校验失败（版本不匹配 / 字段缺失 / 非对象）
 */
export async function importSessionsFromPayload(payload: unknown): Promise<SessionImportRes> {
  const parsed = SessionExportFileSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError(
      ErrorCode.INVALID_INPUT,
      `会话文件格式校验失败（仅支持 version=${SESSION_EXPORT_VERSION} 导出格式）`,
      parsed.error,
    );
  }
  const db = getDb();
  let imported = 0;
  let skipped = 0;
  for (const item of parsed.data.sessions) {
    const existing = db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, item.meta.id))
      .get();
    if (existing !== undefined) {
      skipped += 1;
      continue;
    }
    importOneSession(item);
    imported += 1;
  }
  logger.info(
    { imported, skipped, total: parsed.data.sessions.length },
    '会话导入完成（同 id 会话跳过）',
  );
  return { imported, skipped };
}

/**
 * 导入单个会话（独立事务）
 *
 * 事务内步骤：sessions 行 → messages 批量 → turns（预查全局 turnId 冲突）→ token_usage。
 * 任一步失败整体回滚，该会话在库中零残留；错误向上抛由调用方中止本次导入。
 */
function importOneSession(item: SessionExportItemShape): void {
  const db = getDb();
  const meta = item.meta;
  const messageInserts = resolveMessageInserts(meta.id, item.messages);
  const sessionInsert: SessionInsert = {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...(meta.lastMessage !== undefined ? { lastMessage: meta.lastMessage } : {}),
    // 以实际入库条数为准：损坏消息被跳过时，冗余计数与 messages 表保持自洽
    messageCount: messageInserts.length,
    workingDir: meta.workingDir,
    lastRunStatus: meta.lastRunStatus,
    pinned: meta.pinned ? 1 : 0,
  };
  const usageInserts: TokenUsageInsert[] = item.usage.map((usage) => ({
    sessionId: meta.id,
    modelId: usage.modelId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    createdAt: usage.createdAt,
  }));

  db.transaction((tx) => {
    tx.insert(sessions).values(sessionInsert).run();
    if (messageInserts.length > 0) {
      tx.insert(messages).values(messageInserts).run();
    }
    insertTurnsSkippingConflicts(tx, meta.id, item.turns);
    if (usageInserts.length > 0) {
      tx.insert(tokenUsage).values(usageInserts).run();
    }
  });
}

/**
 * 事务内写入回合（uq_turns_turn_id 全局唯一防冲突）
 *
 * 事务内预查已存在的 turnId（可见同批次先导入会话的未提交行）+ 会话内去重，
 * 冲突者跳过并记 warn——"先到先得"，不因个别回合冲突失败整个会话。
 * 文件内同会话重复 seq 仍会触发 uq_turns_session_seq 回滚（异常文件兜底）。
 */
function insertTurnsSkippingConflicts(
  tx: Omit<ReturnType<typeof getDb>, 'transaction' | '$client'>,
  sessionId: string,
  exportTurns: readonly TurnSummary[],
): void {
  if (exportTurns.length === 0) {
    return;
  }
  const turnIds = exportTurns.map((t) => t.turnId);
  const existing = new Set(
    tx
      .select({ turnId: turns.turnId })
      .from(turns)
      .where(inArray(turns.turnId, turnIds))
      .all()
      .map((row) => row.turnId),
  );
  const inserts: TurnInsert[] = [];
  const seen = new Set<string>();
  for (const turn of exportTurns) {
    if (existing.has(turn.turnId) || seen.has(turn.turnId)) {
      logger.warn({ sessionId, turnId: turn.turnId }, '导入跳过 turnId 冲突的回合');
      continue;
    }
    seen.add(turn.turnId);
    inserts.push({
      turnId: turn.turnId,
      sessionId,
      seq: turn.seq,
      modelId: turn.modelId,
      status: turn.status,
      ...(turn.inputTokens !== undefined ? { inputTokens: turn.inputTokens } : {}),
      ...(turn.outputTokens !== undefined ? { outputTokens: turn.outputTokens } : {}),
      ...(turn.totalTokens !== undefined ? { totalTokens: turn.totalTokens } : {}),
      ...(turn.durationMs !== undefined ? { durationMs: turn.durationMs } : {}),
      createdAt: turn.createdAt,
    });
  }
  if (inserts.length > 0) {
    tx.insert(turns).values(inserts).run();
  }
}

/**
 * 解析消息插入行（role 列 CHECK + NOT NULL 约束）
 *
 * content 为对象 → 取 role 字段；content 为字符串（导出侧损坏兜底形态）→
 * 尝试解析取 role，且落库时保留原始字符串（不二次编码）。解析不出合法
 * role 的损坏消息跳过（记 warn），不阻断会话导入。
 */
function resolveMessageInserts(
  sessionId: string,
  items: readonly SessionExportMessage[],
): MessageInsert[] {
  const inserts: MessageInsert[] = [];
  for (const message of items) {
    const role = resolveImportedRole(message.content);
    if (role === null) {
      logger.warn({ sessionId, seq: message.seq }, '导入跳过无法解析角色的损坏消息');
      continue;
    }
    inserts.push({
      sessionId,
      seq: message.seq,
      ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
      role,
      content:
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      createdAt: message.createdAt,
    });
  }
  return inserts;
}

/** 从导入消息 content 解析 role（合法枚举之外 / 结构损坏 → null 跳过） */
function resolveImportedRole(content: unknown): MessageRole | null {
  const candidate = typeof content === 'string' ? parseJsonSafe(content) : content;
  if (candidate === null || typeof candidate !== 'object') {
    return null;
  }
  const role = (candidate as { role?: unknown }).role;
  return role === 'user' || role === 'assistant' || role === 'tool' || role === 'system'
    ? role
    : null;
}

/** JSON.parse 安全封装（损坏字符串返回 null） */
function parseJsonSafe(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
