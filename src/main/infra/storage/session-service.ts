// src/main/infra/storage/session-service.ts
// SessionService：会话持久化服务（基于 SQLite + Drizzle ORM）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 会话 CRUD：list / get / delete / rename / pin（暴露为 IPC handler）
// - 内部 API：create + appendMessage / replaceMessages（供 AgentService / ChatService 持久化对话历史）
// - 崩溃恢复：markRunning / markIdle / markAllInterrupted（回合状态机）
// - 用量与回合：委托 usage-turn-store（薄委托层，见文件尾部 import）
//
// 拆分（2026-08-31 重构，行为不变）：
// - session-types.ts：ISessionService 接口 + 入参/导出 payload 类型（本文件 re-export 保持外部 import 路径不变）
// - session-helpers.ts：行转换与标题/序列化辅助函数
// - 本文件：SessionService 实现 + 单例管理
//
// 设计：
// - 通过 Drizzle ORM 操作 sessions / messages 两张表（schema 定义见 schema.ts）
// - better-sqlite3 同步驱动：所有 DB 操作阻塞式，无需 await
// - IPC 暴露方法返回纯数据，不含 DB 行类型（避免泄漏 Drizzle 类型）
// - 内部 API 方法返回 sessionId，由 AgentService / ChatService 决定何时调用
//
// 与 AgentService 的关系：
// - AgentService.startAgent 流结束后调用 appendMessage 持久化对话历史
// - SessionService 不感知 AgentService 内部状态（无状态设计）
// - 多窗口/多会话安全：每条消息原子写入，事务保证一致性
//
// 错误分类：
// - 会话不存在：SESSION_NOT_FOUND
// - 入参错误（空标题等）：INVALID_INPUT
// - DB 操作失败：INTERNAL_ERROR
// - JSON 序列化/反序列化失败：INTERNAL_ERROR
// ──────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import type {
  ChatMessage,
  SessionDeleteRes,
  SessionGetRes,
  SessionGetTurnsRes,
  SessionListRecentDirsRes,
  SessionListRes,
  SessionPinRes,
  SessionRecentTurnsRes,
  SessionRenameRes,
  UsageSummaryRes,
} from '@code-agent/shared/main';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { count, desc, eq, sql } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { getDb, reclaimFreePages } from './db';
import { type MessageInsert, messages, type SessionInsert, sessions } from './schema';
import {
  extractRole,
  resolveLastMessagePreview,
  resolveTitle,
  rowToMeta,
  serializeMessage,
} from './session-helpers';
import {
  DEFAULT_SESSION_TITLE,
  type ISessionService,
  type SessionAppendMessageOptions,
  type SessionCreateOptions,
  type SessionExportItem,
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

// 契约层 re-export：外部 import 路径保持 './session-service' 不变（26 处引用零改动）
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

    // 1. 查询当前页会话
    const rows = db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.pinned), desc(sessions.updatedAt))
      .limit(limit)
      .offset(offset)
      .all();

    // 2. 查询总会话数（用于分页计算）
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
  async get(id: string): Promise<SessionGetRes> {
    const db = getDb();

    // 1. 查询会话元数据
    const sessionRow = db.select().from(sessions).where(eq(sessions.id, id)).get();
    if (sessionRow === undefined) {
      throw new AppError(ErrorCode.SESSION_NOT_FOUND, undefined, undefined, { sessionId: id });
    }

    // 2. 查询消息历史（按 seq 升序）
    const messageRows = db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, id))
      .orderBy(messages.seq)
      .all();

    // 3. 反序列化 content JSON（content 存储完整 ModelMessage 的 JSON 字符串）
    const messageList: unknown[] = messageRows.map((row) => {
      try {
        return JSON.parse(row.content) as unknown;
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
    // 级联删除只把页放进 freelist，文件不会自己缩小
    reclaimFreePages();
    return { ok: true };
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

    // better-sqlite3 的 RunResult.changes 表示受影响行数
    if (result.changes === 0) {
      throw new AppError(ErrorCode.SESSION_NOT_FOUND, undefined, undefined, { sessionId: id });
    }

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

    // 计算标题与 lastMessage 预览（事务外，避免持有 DB 锁）
    const title = resolveTitle(options.title, initialMessages, DEFAULT_SESSION_TITLE);
    const lastMessagePreview = resolveLastMessagePreview(initialMessages);

    // 预序列化 messages（M2 修复：在事务外完成 JSON.stringify）
    // - JSON.stringify 是 CPU 密集操作，事务内执行会延长 SQLite 写锁持有时间
    // - 若序列化失败（如循环引用），在事务外抛错，避免 BEGIN/ROLLBACK 开销
    // - 事务体仅保留纯 DB 操作，更易推理
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

    // 事务：保证 sessions 行与 messages 行原子写入
    // 任一步失败则整体回滚，避免出现孤立的 messages 行
    db.transaction((tx) => {
      // 1. 插入 sessions 行
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

      // 2. 批量插入预序列化的 messages 行
      if (messageInserts.length > 0) {
        tx.insert(messages).values(messageInserts).run();
      }
    });

    logger.info({ sessionId, messageCount: initialMessages.length }, '创建新会话');
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

    // 1. 查询会话是否存在 + 当前 messageCount
    const sessionRow = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (sessionRow === undefined) {
      throw new AppError(ErrorCode.SESSION_NOT_FOUND, undefined, undefined, { sessionId });
    }

    // 2. 若无消息追加，仅更新 updatedAt（保持会话活跃）
    if (newMessages.length === 0) {
      db.update(sessions).set({ updatedAt: Date.now() }).where(eq(sessions.id, sessionId)).run();
      return sessionRow.messageCount;
    }

    // 3. 预计算（事务外）：startSeq / now / newLastMessage / messageInserts
    const startSeq = sessionRow.messageCount;
    const now = Date.now();
    const newLastMessage = resolveLastMessagePreview(newMessages);
    const messageInserts: MessageInsert[] = newMessages.map((msg, index) => ({
      sessionId,
      // exactOptionalPropertyTypes：turnId 未传时条件展开（不写 NULL）
      ...(options.turnId !== undefined ? { turnId: options.turnId } : {}),
      seq: startSeq + index,
      role: extractRole(msg),
      content: serializeMessage(msg),
      createdAt: now,
    }));

    // 4. 事务：批量插入 messages + 更新 sessions
    //    条件展开：若追加消息中无 user 角色消息，保留原 lastMessage 不变
    //    （exactOptionalPropertyTypes 要求可选字段不能显式传 undefined，
    //     用条件展开而非 Partial 类型，让 TS 自动推导出正确类型）
    db.transaction((tx) => {
      // 批量插入预序列化的 messages 行
      tx.insert(messages).values(messageInserts).run();

      // 更新 sessions：updatedAt + messageCount（+ lastMessage 若有新 user 消息）
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
    // 压缩掉的旧消息页需在事务外回收：VACUUM 类 pragma 不能在事务内执行
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
    // 反序列化 content JSON（与 get 的语义一致：解析失败抛 INTERNAL_ERROR）
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
  async dispose(): Promise<void> {
    // 无操作
  }

  // ── 崩溃恢复（回合状态机） ──────────────────────────────

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
    // 启动时把所有 running 残留置为 interrupted（上次进程异常退出的证据）
    const result = db
      .update(sessions)
      .set({ lastRunStatus: 'interrupted' })
      .where(eq(sessions.lastRunStatus, 'running'))
      .run();
    return result.changes;
  }

  /** 导出全部会话（元数据 + 消息历史），数据资产可迁移 */
  async exportAll(): Promise<SessionExportPayload> {
    const db = getDb();
    const rows = db.select().from(sessions).orderBy(desc(sessions.updatedAt)).all();
    const items: SessionExportItem[] = rows.map((row) => {
      const messageRows = db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, row.id))
        .orderBy(messages.seq)
        .all();
      return {
        meta: rowToMeta(row),
        messages: messageRows.map((m) => {
          try {
            return JSON.parse(m.content) as unknown;
          } catch {
            // 损坏的 content 保留原始字符串（导出不丢数据）
            return m.content;
          }
        }),
      };
    });
    return { exportedAt: Date.now(), app: 'code-agent-desktop', sessions: items };
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

    // 原始 SQL 查询:去重 + 取 MAX(updated_at) + 过滤空字符串 + 倒序
    // 列别名使用 camelCase 以符合 biome useNamingConvention 规则
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

  // ── token 用量统计 / Transcript（薄委托 usage-turn-store） ──────────

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

// ─── 单例管理（与 FileService / GitService 一致） ─────────────

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
