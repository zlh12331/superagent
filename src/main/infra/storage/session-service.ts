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

/**
 * SessionService 默认实现
 *
 * 单例模式：通过 ServiceContainer 持有，整个应用生命周期共享一个实例。
 * 内部不持有 DB 连接（通过 getDb() 动态获取），便于测试重置。
 *
 * 所有 DB 操作都通过 drizzle 的同步 API（better-sqlite3 driver）：
 * - db.select().from(...).where(...).orderBy(...).limit(...).offset(...).all()
 * - db.insert(...).values(...).run()
 * - db.update(...).set(...).where(...).run()
 * - db.delete(...).where(...).run()
 * - db.transaction(() => { ... }) 事务包裹复合操作
 */
export class SessionService {
  /**
   * 分页列出所有会话
   *
   * 返回按 updatedAt 倒序的会话列表 + 总数（用于分页计算）。
   * 不包含完整消息历史，仅元数据（SessionMeta）。
   * 置顶优先，同置顶内按 updatedAt 倒序——对齐参考项目 pinned-header 分组。
   *
   * @param limit 单页数量（已由 zod schema 校验，1-100）
   * @param offset 偏移量（已由 zod schema 校验，>=0）
   */
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

  /**
   * 获取指定会话的完整消息历史
   *
   * @param id 会话 id（已由 zod schema 校验非空）
   * @throws AppError(SESSION_NOT_FOUND) 会话不存在
   * @throws AppError(INTERNAL_ERROR) JSON 反序列化失败
   */
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

  /**
   * 删除指定会话
   *
   * 利用外键 ON DELETE CASCADE：删除 sessions 行时自动级联删除 messages 表相关行。
   * 幂等：删除不存在的 sessionId 不报错，返回 ok=true。
   */
  async delete(id: string): Promise<SessionDeleteRes> {
    const db = getDb();
    db.delete(sessions).where(eq(sessions.id, id)).run();
    reclaimFreePages();
    broadcastInvalidation([INVALIDATION_DOMAINS.sessions]);
    return { ok: true };
  }

  /**
   * 清空全部会话（36-D）
   *
   * 无 where 全表删除：messages / turns / goals 经 FK ON DELETE CASCADE 一并级联；
   * tasks / cron_tasks 无外键（有意），不受影响。幂等：空表 → deleted=0。
   * 运行中回合守卫在 handler 层（SESSION_IN_USE）——服务层保持纯数据操作，
   * 与 compactMessages 注入同模式。
   */
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

  /**
   * 重命名会话标题（同时更新 updatedAt）
   *
   * @throws AppError(SESSION_NOT_FOUND) 会话不存在
   */
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

  /**
   * 置顶/取消置顶会话（对齐参考项目 pinned-header 分组）
   *
   * 不存在的会话：返回 ok: false（幂等，不抛错）
   */
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

  /**
   * 创建新会话（内部 API）
   *
   * 流程：
   * 1. 生成 sessionId（randomUUID）
   * 2. 计算 title（用户传入 > 首条 user 消息预览 > '新会话'）
   * 3. 计算 lastMessage（最后一条 user 消息前 100 字符，无则 null）
   * 4. 事务：插入 sessions 行 + 批量插入 messages 行
   * 5. 返回 sessionId
   */
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

  /**
   * 向指定会话追加消息（内部 API）
   *
   * 流程：校验会话存在 → 事务（批量插入 messages 行 + 更新 sessions.updatedAt/messageCount/lastMessage）
   *
   * 设计：
   * - 使用事务保证原子性（messages 与 sessions 同步更新）
   * - 不校验 messages 非空（空数组为 no-op，但仍更新 updatedAt）
   * - lastMessage 取追加的最后一条 user 消息预览（若追加消息中无 user，保留原 lastMessage）
   * - M2 修复：serializeMessage 在事务外完成，避免 JSON.stringify 延长 SQLite 写锁
   *
   * @throws AppError(SESSION_NOT_FOUND) 会话不存在
   * @throws AppError(INTERNAL_ERROR) 消息 JSON 序列化失败
   */
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

  /**
   * 整体替换会话消息（/compact 上下文压缩内部 API）
   *
   * 流程：校验会话存在 → 事务（删除全部 messages 行 → 重插压缩后消息 +
   * 更新 sessions.messageCount/lastMessage/updatedAt）。
   * 注意：被压缩掉的历史消息对应的回合 transcript（getTurnMessages）随之清空——
   * 这是压缩的固有语义（旧上下文不可回放）。
   *
   * @throws AppError(SESSION_NOT_FOUND) 会话不存在
   */
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

  /**
   * 查询指定回合的消息明细（Transcript 消息级回放）
   */
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

  /**
   * 优雅关闭（无外部资源）
   *
   * SessionService 不持有 DB 连接（通过 getDb() 动态获取），
   * db 实例由 closeDb 在 ServiceContainer.dispose 中统一关闭。
   * 保留 dispose 方法以满足接口一致性，便于未来扩展（如缓存）。
   */
  async dispose(): Promise<void> {}

  async markRunning(id: string): Promise<void> {
    const db = getDb();
    db.update(sessions).set({ lastRunStatus: 'running' }).where(eq(sessions.id, id)).run();
  }

  async markIdle(id: string): Promise<void> {
    const db = getDb();
    db.update(sessions).set({ lastRunStatus: 'idle' }).where(eq(sessions.id, id)).run();
  }

  async markAllInterrupted(): Promise<number> {
    const db = getDb();
    const result = db
      .update(sessions)
      .set({ lastRunStatus: 'interrupted' })
      .where(eq(sessions.lastRunStatus, 'running'))
      .run();
    return result.changes;
  }

  /**
   * 导出全部会话（元数据 + 消息 + 回合 + token 用量）
   *
   * 实现委托 session-io（导出/导入存储层自成一块，本文件保持体量），
   * 输出为 version=1 的 SessionExportFile 文件格式（schema 见 shared）。
   */
  async exportAll(): Promise<SessionExportPayload> {
    return exportAllSessions();
  }

  /**
   * 导入会话（version=1 导出文件格式）
   *
   * 实现委托 session-io：zod 校验 → 同 id 会话跳过并计数 → 每会话事务落库。
   *
   * @throws AppError(INVALID_INPUT) 文件格式校验失败
   */
  async importAll(payload: unknown): Promise<SessionImportRes> {
    const result = await importSessionsFromPayload(payload);
    if (result.imported > 0) {
      broadcastInvalidation([INVALIDATION_DOMAINS.sessions]);
    }
    return result;
  }

  /**
   * 查询最近使用的目录列表
   *
   * 从 sessions 表查询去重后的 workingDir,按最后使用时间倒序。
   * 空字符串 workingDir 被过滤(旧 chat 会话兼容)。
   *
   * @param req.limit 返回条数上限(已由 zod schema 校验 1-50)
   */
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

  /** @inheritDoc */
  pruneExpiredUsage(): number {
    return storePruneExpiredUsage();
  }

  /** @inheritDoc */
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

  /** @inheritDoc */
  async getUsageSummary(): Promise<UsageSummaryRes> {
    return storeGetUsageSummary();
  }

  /** @inheritDoc */
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

  /** @inheritDoc */
  async getTurns(sessionId: string): Promise<SessionGetTurnsRes> {
    return storeGetTurns(sessionId);
  }

  /** @inheritDoc */
  async getRecentTurns(req: { readonly limit: number }): Promise<SessionRecentTurnsRes> {
    return storeGetRecentTurns(req);
  }
}

/** SessionService 单例（内部按具体实现类持有，外部暴露为 ISessionService 接口） */
let sessionService: SessionService | null = null;

/**
 * 获取 SessionService 单例
 *
 * 整个应用生命周期共享一个实例。
 *
 * 返回类型为 ISessionService 接口而非具体类：
 * - 强制调用方面向接口编程，不依赖 SessionService 内部细节
 * - ServiceContainer 注入到 IPC handler 时类型一致
 */
export function getSessionService(): ISessionService {
  if (sessionService === null) {
    sessionService = new SessionService();
  }
  return sessionService;
}

/**
 * 重置 SessionService（仅测试用）
 *
 * SessionService 无外部资源（不持有 DB 连接），仅清空单例缓存。
 */
export function resetSessionService(): void {
  sessionService = null;
}
