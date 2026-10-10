// session-io.ts：会话全量导出/导入——自描述 JSON 载荷（schema 版本号 + 批量取数控内存）
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

// 导出载荷标识（导入时校验非本应用文件直接拒）
const EXPORT_APP_ID = 'code-agent-desktop';

// 关联表按 500 会话一批 IN 查询：SQLite 变量数上限与内存双保险
const EXPORT_BATCH_SIZE = 500;

export async function exportAllSessions(): Promise<SessionExportPayload> {
  const db = getDb();
  const rows = db.select().from(sessions).orderBy(desc(sessions.updatedAt)).all();
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

function toExportMessage(row: MessageRow): SessionExportMessage {
  let content: unknown;
  try {
    content = JSON.parse(row.content);
  } catch {
    content = row.content;
  }
  return {
    seq: row.seq,
    ...(row.turnId !== null ? { turnId: row.turnId } : {}),
    content,
    createdAt: row.createdAt,
  };
}

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

function parseJsonSafe(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
