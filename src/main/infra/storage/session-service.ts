// session-service.ts：会话服务——CRUD/置顶/清空/消息追加与替换/运行状态标记/导入导出
// 约定：每次写操作后广播对应失效域（渲染层 TanStack Query 依赖此刷新）；批量写走事务保序
import { randomUUID } from 'node:crypto';
import type {
  ChatMessage,
  SessionClearAllRes,
  SessionDeleteRes,
  SessionGetRes,
  SessionGetTurnsRes,
  SessionImportRes,
  SessionListRecentDirsRes,
  SessionListRes,
  SessionPinRes,
  SessionRecentTurnsRes,
  SessionRenameRes,
  UsageSummaryRes,
} from '@code-agent/shared/main';
import { AppError, ErrorCode, INVALIDATION_DOMAINS } from '@code-agent/shared/main';
import { count, desc, eq, sql } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { broadcastInvalidation } from '../invalidation/invalidation';
import { getDb, reclaimFreePages } from './db';
import { type MessageInsert, messages, type SessionInsert, sessions } from './schema';
import {
  extractRole,
  resolveLastMessagePreview,
  resolveTitle,
  rowToMeta,
  serializeMessage,
} from './session-helpers';
import { exportAllSessions, importSessionsFromPayload } from './session-io';
import {
  DEFAULT_SESSION_TITLE,
  type ISessionService,
  type SessionAppendMessageOptions,
  type SessionCreateOptions,
  type SessionExportPayload,
} from './session-types';
import {
  getRecentTurns as storeGetRecentTurns,
  getTurns as storeGetTurns,
  getUsageSummary as storeGetUsageSummary,
  pruneExpiredUsage as storePruneExpiredUsage,
  recordTurn as storeRecordTurn,
  recordUsage as storeRecordUsage,
} from './usage-turn-store';

export {
  DEFAULT_SESSION_TITLE,
  type ISessionService,
  type SessionAppendMessageOptions,
  type SessionCreateOptions,
  type SessionExportItem,
  type SessionExportPayload,
} from './session-types';

export class SessionService {
  /** 会话分页列表：置顶优先，其余按更新时间倒序 */
  async list(limit: number, offset: number): Promise<SessionListRes> {
    const db = getDb();

    const rows = db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.pinned), desc(sessions.updatedAt))
      .limit(limit)
      .offset(offset)
      .all();

    const totalRow = db.select({ value: count() }).from(sessions).get();
    const total = totalRow?.value ?? 0;

    return {
      sessions: rows.map(rowToMeta),
      total,
    };
  }

  /** 会话详情：includeMessages=false 时省消息体查询（列表态只关心元数据） */
  async get(id: string, options?: { includeMessages?: boolean }): Promise<SessionGetRes> {
    const db = getDb();

    const sessionRow = db.select().from(sessions).where(eq(sessions.id, id)).get();
    if (sessionRow === undefined) {
      throw new AppError(ErrorCode.SESSION_NOT_FOUND, undefined, undefined, { sessionId: id });
    }

    if (options?.includeMessages === false) {
      return { session: rowToMeta(sessionRow), messages: [] };
    }
    const messageRows = db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, id))
      .orderBy(messages.seq)
      .all();

    const messageList: ChatMessage[] = messageRows.map((row) => {
      try {
        return JSON.parse(row.content) as ChatMessage;
      } catch (error) {
        throw new AppError(
          ErrorCode.INTERNAL_ERROR,
          `消息 JSON 解析失败（sessionId=${id}, seq=${row.seq}）`,
          error,
          { sessionId: id, seq: row.seq },
        );
      }
    });

    return {
      session: rowToMeta(sessionRow),
      messages: messageList,
    };
  }

  /** 删除会话（messages/goals/turns 级联）；删后归还空闲页——删除是碎片主来源 */
  async delete(id: string): Promise<SessionDeleteRes> {
    const db = getDb();
    db.delete(sessions).where(eq(sessions.id, id)).run();
    reclaimFreePages();
    broadcastInvalidation([INVALIDATION_DOMAINS.sessions]);
    return { ok: true };
  }

  async clearAll(): Promise<SessionClearAllRes> {
    const db = getDb();
    const result = db.delete(sessions).run();
    const deleted = result.changes;
    reclaimFreePages();
    broadcastInvalidation([
      INVALIDATION_DOMAINS.sessions,
      INVALIDATION_DOMAINS.usage,
      INVALIDATION_DOMAINS.turns,
      INVALIDATION_DOMAINS.goal,
    ]);
    logger.info({ deleted }, '全部会话已清空');
    return { deleted };
  }

  async rename(id: string, title: string): Promise<SessionRenameRes> {
    const db = getDb();

    const result = db
      .update(sessions)
      .set({ title, updatedAt: Date.now() })
      .where(eq(sessions.id, id))
      .run();

    if (result.changes === 0) {
      throw new AppError(ErrorCode.SESSION_NOT_FOUND, undefined, undefined, { sessionId: id });
    }

    broadcastInvalidation([INVALIDATION_DOMAINS.sessions, INVALIDATION_DOMAINS.session(id)]);
    return { ok: true };
  }

  async pin(id: string, pinned: boolean): Promise<SessionPinRes> {
    const db = getDb();
    const result = db
      .update(sessions)
      .set({ pinned: pinned ? 1 : 0, updatedAt: Date.now() })
      .where(eq(sessions.id, id))
      .run();
    if (result.changes > 0) {
      broadcastInvalidation([INVALIDATION_DOMAINS.sessions, INVALIDATION_DOMAINS.session(id)]);
    }
    return { ok: result.changes > 0 };
  }

  async create(options: SessionCreateOptions): Promise<string> {
    const db = getDb();
    const now = Date.now();
    const sessionId = randomUUID();
    const initialMessages = options.messages ?? [];

    const title = resolveTitle(options.title, initialMessages, DEFAULT_SESSION_TITLE);
    const lastMessagePreview = resolveLastMessagePreview(initialMessages);

    const messageInserts: MessageInsert[] =
      initialMessages.length > 0
        ? initialMessages.map((msg, index) => ({
            sessionId,
            seq: index,
            role: extractRole(msg),
            content: serializeMessage(msg),
            createdAt: now,
          }))
        : [];

    db.transaction((tx) => {
      const sessionInsert: SessionInsert = {
        id: sessionId,
        title,
        createdAt: now,
        updatedAt: now,
        lastMessage: lastMessagePreview,
        messageCount: initialMessages.length,
        workingDir: options.workingDir,
      };
      tx.insert(sessions).values(sessionInsert).run();

      if (messageInserts.length > 0) {
        tx.insert(messages).values(messageInserts).run();
      }
    });

    logger.info({ sessionId, messageCount: initialMessages.length }, '创建新会话');
    broadcastInvalidation([INVALIDATION_DOMAINS.sessions, INVALIDATION_DOMAINS.session(sessionId)]);
    return sessionId;
  }

  /** 追加消息（事务内重读行锁保 seq 连续——防并发追加跳号）；空消息仅刷新 updatedAt */
  async appendMessage(options: SessionAppendMessageOptions): Promise<number> {
    const db = getDb();
    const { sessionId, messages: newMessages } = options;

    const sessionRow = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (sessionRow === undefined) {
      throw new AppError(ErrorCode.SESSION_NOT_FOUND, undefined, undefined, { sessionId });
    }

    if (newMessages.length === 0) {
      db.update(sessions).set({ updatedAt: Date.now() }).where(eq(sessions.id, sessionId)).run();
      broadcastInvalidation([
        INVALIDATION_DOMAINS.sessions,
        INVALIDATION_DOMAINS.session(sessionId),
      ]);
      return sessionRow.messageCount;
    }

    const now = Date.now();
    const newLastMessage = resolveLastMessagePreview(newMessages);
    const serializedRows: Array<Pick<MessageInsert, 'turnId' | 'role' | 'content'>> =
      newMessages.map((msg) => ({
        ...(options.turnId !== undefined ? { turnId: options.turnId } : {}),
        role: extractRole(msg),
        content: serializeMessage(msg),
      }));

    let startSeq = 0;
    db.transaction((tx) => {
      const locked = tx.select().from(sessions).where(eq(sessions.id, sessionId)).get();
      if (locked === undefined) {
        throw new AppError(ErrorCode.SESSION_NOT_FOUND, undefined, undefined, { sessionId });
      }
      startSeq = locked.messageCount;
      tx.insert(messages)
        .values(
          serializedRows.map((row, index) => ({
            sessionId,
            ...row,
            seq: startSeq + index,
            createdAt: now,
          })),
        )
        .run();

      tx.update(sessions)
        .set({
          updatedAt: now,
          messageCount: startSeq + newMessages.length,
          ...(newLastMessage !== null ? { lastMessage: newLastMessage } : {}),
        })
        .where(eq(sessions.id, sessionId))
        .run();
    });

    logger.info(
      { sessionId, appended: newMessages.length, total: startSeq + newMessages.length },
      '追加会话消息',
    );
    broadcastInvalidation([INVALIDATION_DOMAINS.sessions, INVALIDATION_DOMAINS.session(sessionId)]);
    return startSeq + newMessages.length;
  }

  /** 整体替换消息（上下文压缩写回路径）：事务内删旧插新，seq 从 0 重排 */
  async replaceMessages(sessionId: string, newMessages: readonly ChatMessage[]): Promise<number> {
    const db = getDb();
    const sessionRow = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (sessionRow === undefined) {
      throw new AppError(ErrorCode.SESSION_NOT_FOUND, undefined, undefined, { sessionId });
    }
    const now = Date.now();
    const newLastMessage = resolveLastMessagePreview(newMessages);
    const messageInserts: MessageInsert[] = newMessages.map((msg, index) => ({
      sessionId,
      seq: index,
      role: extractRole(msg),
      content: serializeMessage(msg),
      createdAt: now,
    }));
    db.transaction((tx) => {
      tx.delete(messages).where(eq(messages.sessionId, sessionId)).run();
      if (messageInserts.length > 0) {
        tx.insert(messages).values(messageInserts).run();
      }
      tx.update(sessions)
        .set({
          updatedAt: now,
          messageCount: newMessages.length,
          ...(newLastMessage !== null ? { lastMessage: newLastMessage } : {}),
        })
        .where(eq(sessions.id, sessionId))
        .run();
    });
    logger.info({ sessionId, messageCount: newMessages.length }, '替换会话消息（上下文压缩）');
    broadcastInvalidation([INVALIDATION_DOMAINS.sessions, INVALIDATION_DOMAINS.session(sessionId)]);
    reclaimFreePages();
    return newMessages.length;
  }

  async getTurnMessages(turnId: string): Promise<ChatMessage[]> {
    const db = getDb();
    const rows = db
      .select()
      .from(messages)
      .where(eq(messages.turnId, turnId))
      .orderBy(messages.seq)
      .all();
    return rows.map((row) => {
      try {
        return JSON.parse(row.content) as ChatMessage;
      } catch (error) {
        throw new AppError(
          ErrorCode.INTERNAL_ERROR,
          `回合消息 JSON 解析失败（turnId=${turnId}, seq=${row.seq}）`,
          error,
          { turnId, seq: row.seq },
        );
      }
    });
  }

  async dispose(): Promise<void> {}

  async markRunning(id: string): Promise<void> {
    const db = getDb();
    db.update(sessions).set({ lastRunStatus: 'running' }).where(eq(sessions.id, id)).run();
  }

  async markIdle(id: string): Promise<void> {
    const db = getDb();
    db.update(sessions).set({ lastRunStatus: 'idle' }).where(eq(sessions.id, id)).run();
  }

  /** 崩溃善后：全部 running 会话标 interrupted（启动 recoverFromCrash 与退出 dispose 共用） */
  async markAllInterrupted(): Promise<number> {
    const db = getDb();
    const result = db
      .update(sessions)
      .set({ lastRunStatus: 'interrupted' })
      .where(eq(sessions.lastRunStatus, 'running'))
      .run();
    return result.changes;
  }

  async exportAll(): Promise<SessionExportPayload> {
    return exportAllSessions();
  }

  async importAll(payload: unknown): Promise<SessionImportRes> {
    const result = await importSessionsFromPayload(payload);
    if (result.imported > 0) {
      broadcastInvalidation([INVALIDATION_DOMAINS.sessions]);
    }
    return result;
  }

  async listRecentDirs(req: { readonly limit: number }): Promise<SessionListRecentDirsRes> {
    const db = getDb();
    const { limit } = req;

    const rows = db.all<{ workingDir: string; lastUsed: number }>(
      sql`SELECT DISTINCT working_dir as workingDir, MAX(updated_at) as lastUsed
          FROM sessions
          WHERE working_dir != ''
          GROUP BY working_dir
          ORDER BY lastUsed DESC
          LIMIT ${limit}`,
    );

    return {
      dirs: rows.map((row) => ({
        workingDir: row.workingDir,
        lastUsed: row.lastUsed,
      })),
    };
  }

  pruneExpiredUsage(): number {
    return storePruneExpiredUsage();
  }

  async recordUsage(usage: {
    readonly sessionId: string;
    readonly modelId: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly cacheReadTokens: number | undefined;
    readonly reasoningTokens: number | undefined;
  }): Promise<void> {
    return storeRecordUsage(usage);
  }

  async getUsageSummary(): Promise<UsageSummaryRes> {
    return storeGetUsageSummary();
  }

  async recordTurn(turn: {
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
    return storeRecordTurn(turn);
  }

  async getTurns(sessionId: string): Promise<SessionGetTurnsRes> {
    return storeGetTurns(sessionId);
  }

  async getRecentTurns(req: { readonly limit: number }): Promise<SessionRecentTurnsRes> {
    return storeGetRecentTurns(req);
  }
}

let sessionService: SessionService | null = null;

export function getSessionService(): ISessionService {
  if (sessionService === null) {
    sessionService = new SessionService();
  }
  return sessionService;
}

export function resetSessionService(): void {
  sessionService = null;
}
