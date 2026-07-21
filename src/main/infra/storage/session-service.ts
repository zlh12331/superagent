// src/main/infra/storage/session-service.ts
// SessionService：会话持久化服务（基于 SQLite + Drizzle ORM）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 会话 CRUD：list / get / delete / rename（暴露为 IPC handler）
// - 内部 API：create + appendMessage（供 AgentService / ChatService 持久化对话历史）
// - 消息序列化：ChatMessage[] ↔ JSON string（messages.content 列）
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
  SessionListRes,
  SessionMeta,
  SessionRenameRes,
} from '@novel-writer/shared';
import { AppError, ErrorCode } from '@novel-writer/shared';
import { count, desc, eq } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { getDb } from './db';
import { type MessageInsert, messages, type SessionInsert, sessions } from './schema';

/**
 * create 方法入参
 *
 * 设计：title 与 initialMessages 均为可选，由调用方决定是否在创建时就写入消息。
 * - AgentService.startAgent 流结束后调用 create 持久化（仅传入 messages，title 自动生成）
 * - 渲染层若需要"先创建空会话再发消息"模式，可省略 initialMessages
 */
export interface SessionCreateOptions {
  /**
   * 可选标题
   *
   * 省略时自动生成：取首条 user 消息内容前 50 字符；无 user 消息则用 '新会话'。
   */
  readonly title: string | undefined;
  /**
   * 初始消息历史（可选）
   *
   * 通常为 AgentService.startAgent 收到的完整 messages 数组。
   * 省略时创建空会话，后续通过 appendMessage 追加。
   */
  readonly messages: readonly ChatMessage[] | undefined;
}

/**
 * appendMessage 方法入参
 */
export interface SessionAppendMessageOptions {
  /** 目标会话 id */
  readonly sessionId: string;
  /** 要追加的消息数组（按顺序写入，seq 自动递增） */
  readonly messages: readonly ChatMessage[];
}

/**
 * SessionService 接口
 *
 * 解耦 IPC handler 对具体类的依赖，便于：
 * - 单元测试：注入 mock 实现，不依赖真实 SQLite
 * - 未来扩展：替换为 Postgres / IndexedDB 等其他存储后端
 *
 * 两组方法：
 * 1. IPC 暴露（list/get/delete/rename）：渲染层通过 IPC 调用
 * 2. 内部 API（create/appendMessage）：AgentService / ChatService 调用
 */
export interface ISessionService {
  // ── IPC 暴露方法 ───────────────────────────────────

  /** 分页列出所有会话（按 updatedAt 倒序） */
  list(limit: number, offset: number): Promise<SessionListRes>;
  /** 获取指定会话的完整消息历史 */
  get(id: string): Promise<SessionGetRes>;
  /** 删除指定会话（连同 messages 表级联删除） */
  delete(id: string): Promise<SessionDeleteRes>;
  /** 重命名会话标题 */
  rename(id: string, title: string): Promise<SessionRenameRes>;

  // ── 内部 API（供 AgentService / ChatService 调用） ────

  /** 创建新会话（可选写入初始消息历史），返回 sessionId */
  create(options: SessionCreateOptions): Promise<string>;
  /** 向指定会话追加消息（seq 自动递增），返回追加后的消息总数 */
  appendMessage(options: SessionAppendMessageOptions): Promise<number>;

  /** 优雅关闭（无外部资源，db 由 closeDb 在 ServiceContainer.dispose 中关闭） */
  dispose(): Promise<void>;
}

/**
 * 默认空会话标题
 *
 * 当传入 messages 中无 user 角色消息时使用。
 */
const DEFAULT_SESSION_TITLE = '新会话';

/**
 * 会话标题最大长度（与 SessionRenameReqSchema 一致）
 */
const TITLE_MAX_LENGTH = 100;

/**
 * 标题预览长度（从首条 user 消息截取）
 */
const TITLE_PREVIEW_LENGTH = 50;

/**
 * lastMessage 预览长度（从最后一条 user 消息截取）
 */
const LAST_MESSAGE_PREVIEW_LENGTH = 100;

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
class SessionService implements ISessionService {
  /**
   * 分页列出所有会话
   *
   * 返回按 updatedAt 倒序的会话列表 + 总数（用于分页计算）。
   * 不包含完整消息历史，仅元数据（SessionMeta）。
   *
   * @param limit 单页数量（已由 zod schema 校验，1-100）
   * @param offset 偏移量（已由 zod schema 校验，>=0）
   */
  async list(limit: number, offset: number): Promise<SessionListRes> {
    const db = getDb();

    // 1. 查询当前页会话（按 updatedAt 倒序）
    const rows = db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.updatedAt))
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
   * 流程：
   * 1. 查询 sessions 行（不存在则抛 SESSION_NOT_FOUND）
   * 2. 查询 messages 行（按 seq 升序）
   * 3. 反序列化 content JSON → ChatMessage
   * 4. 组装 SessionGetRes
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

    // 3. 反序列化 content JSON → ChatMessage
    //    content 存储完整 ModelMessage 的 JSON 字符串，由 create/appendMessage 序列化
    //    反序列化为 unknown[]（对齐 SessionGetRes.messages 类型，避免泄漏 ChatMessage 类型到 shared）
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
   *
   * @param id 会话 id（已由 zod schema 校验非空）
   */
  async delete(id: string): Promise<SessionDeleteRes> {
    const db = getDb();
    // 外键级联：sessions 行删除时，messages 表相关行自动删除
    db.delete(sessions).where(eq(sessions.id, id)).run();
    return { ok: true };
  }

  /**
   * 重命名会话标题
   *
   * @param id 会话 id（已由 zod schema 校验非空）
   * @param title 新标题（已由 zod schema 校验 1-100 字符）
   * @throws AppError(SESSION_NOT_FOUND) 会话不存在
   */
  async rename(id: string, title: string): Promise<SessionRenameRes> {
    const db = getDb();

    // 执行重命名（同时更新 updatedAt）
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
   * 创建新会话（内部 API）
   *
   * 流程：
   * 1. 生成 sessionId（randomUUID）
   * 2. 计算 title（用户传入 > 首条 user 消息预览 > '新会话'）
   * 3. 计算 lastMessage（最后一条 user 消息前 100 字符，无则 null）
   * 4. 事务：插入 sessions 行 + 批量插入 messages 行
   * 5. 返回 sessionId
   *
   * @param options.title 可选标题
   * @param options.messages 可选初始消息历史
   * @returns 新建会话的 sessionId
   */
  async create(options: SessionCreateOptions): Promise<string> {
    const db = getDb();
    const now = Date.now();
    const sessionId = randomUUID();
    const initialMessages = options.messages ?? [];

    // 计算标题与 lastMessage 预览
    const title = resolveTitle(options.title, initialMessages);
    const lastMessagePreview = resolveLastMessagePreview(initialMessages);

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
      };
      tx.insert(sessions).values(sessionInsert).run();

      // 2. 批量插入 messages 行（seq 从 0 递增）
      if (initialMessages.length > 0) {
        const messageInserts: MessageInsert[] = initialMessages.map((msg, index) => ({
          sessionId,
          seq: index,
          role: extractRole(msg),
          content: serializeMessage(msg),
          createdAt: now,
        }));
        tx.insert(messages).values(messageInserts).run();
      }
    });

    logger.info({ sessionId, messageCount: initialMessages.length }, '创建新会话');
    return sessionId;
  }

  /**
   * 向指定会话追加消息（内部 API）
   *
   * 流程：
   * 1. 校验 sessionId 存在（不存在抛 SESSION_NOT_FOUND）
   * 2. 查询当前 messageCount（作为起始 seq）
   * 3. 事务：批量插入 messages 行 + 更新 sessions.updatedAt/lastMessage/messageCount
   * 4. 返回追加后的消息总数
   *
   * 设计：
   * - 使用事务保证原子性（messages 与 sessions 同步更新）
   * - 不校验 messages 非空（空数组为 no-op，但仍更新 updatedAt）
   * - lastMessage 取追加的最后一条 user 消息预览（若追加消息中无 user，保留原 lastMessage）
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

    // 3. 事务：批量插入 messages + 更新 sessions
    //    条件展开：若追加消息中无 user 角色消息，保留原 lastMessage 不变
    //    （exactOptionalPropertyTypes 要求可选字段不能显式传 undefined，
    //     用条件展开而非 Partial 类型，让 TS 自动推导出正确类型）
    const startSeq = sessionRow.messageCount;
    const now = Date.now();
    const newLastMessage = resolveLastMessagePreview(newMessages);

    db.transaction((tx) => {
      // 批量插入 messages 行
      const messageInserts: MessageInsert[] = newMessages.map((msg, index) => ({
        sessionId,
        seq: startSeq + index,
        role: extractRole(msg),
        content: serializeMessage(msg),
        createdAt: now,
      }));
      tx.insert(messages).values(messageInserts).run();

      // 更新 sessions：updatedAt + messageCount（+ lastMessage 若有新 user 消息）
      // 条件展开避免显式传 undefined，符合 exactOptionalPropertyTypes
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
   * 优雅关闭（无外部资源）
   *
   * SessionService 不持有 DB 连接（通过 getDb() 动态获取），
   * db 实例由 closeDb 在 ServiceContainer.dispose 中统一关闭。
   * 保留 dispose 方法以满足接口一致性，便于未来扩展（如缓存）。
   */
  async dispose(): Promise<void> {
    // 无操作
  }
}

// ─── 辅助函数（模块私有，不导出） ──────────────────────────────

/**
 * 将 SessionRow 转换为 SessionMeta（IPC 响应类型）
 *
 * 字段对齐：
 * - id / title / createdAt / updatedAt / messageCount 直接透传
 * - lastMessage 是 nullable text，转为 string | undefined（对齐 zod schema 推断类型）
 */
function rowToMeta(row: typeof sessions.$inferSelect): SessionMeta {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastMessage: row.lastMessage ?? undefined,
    messageCount: row.messageCount,
  };
}

/**
 * 解析会话标题
 *
 * 优先级：
 * 1. 调用方显式传入的 title（非空时直接使用，超长截断到 100 字符）
 * 2. 首条 user 消息内容前 50 字符
 * 3. '新会话'（默认值）
 */
function resolveTitle(title: string | undefined, messageList: readonly ChatMessage[]): string {
  // 1. 调用方显式传入
  if (title !== undefined && title.length > 0) {
    return title.length > TITLE_MAX_LENGTH ? title.slice(0, TITLE_MAX_LENGTH) : title;
  }

  // 2. 首条 user 消息预览
  const firstUserContent = findFirstUserText(messageList);
  if (firstUserContent !== null) {
    const preview =
      firstUserContent.length > TITLE_PREVIEW_LENGTH
        ? firstUserContent.slice(0, TITLE_PREVIEW_LENGTH)
        : firstUserContent;
    return preview;
  }

  // 3. 默认值
  return DEFAULT_SESSION_TITLE;
}

/**
 * 解析 lastMessage 预览
 *
 * 取消息历史中最后一条 user 消息内容前 100 字符。
 * 若消息历史中无 user 消息，返回 null（表示 lastMessage 字段为空）。
 */
function resolveLastMessagePreview(messageList: readonly ChatMessage[]): string | null {
  const lastUserContent = findLastUserText(messageList);
  if (lastUserContent === null) {
    return null;
  }
  return lastUserContent.length > LAST_MESSAGE_PREVIEW_LENGTH
    ? lastUserContent.slice(0, LAST_MESSAGE_PREVIEW_LENGTH)
    : lastUserContent;
}

/**
 * 从消息历史中提取首条 user 角色消息的文本内容
 *
 * ChatMessage 是 AI SDK 的 ModelMessage 联合类型，content 可为：
 * - string：简单文本
 * - 数组：多模态（如 [{type: 'text', text}, {type: 'image', image}]）
 *
 * 仅提取 string 类型 content，数组类型跳过（Code Agent 场景下 user 消息通常为纯文本）。
 *
 * @returns 首条 user 消息文本，无则 null
 */
function findFirstUserText(messageList: readonly ChatMessage[]): string | null {
  for (const msg of messageList) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      return msg.content;
    }
  }
  return null;
}

/**
 * 从消息历史中提取最后一条 user 角色消息的文本内容
 *
 * 与 findFirstUserText 对应，但反向遍历取最后一条。
 * 用于 lastMessage 预览（展示用户最近一次提问）。
 */
function findLastUserText(messageList: readonly ChatMessage[]): string | null {
  for (let i = messageList.length - 1; i >= 0; i -= 1) {
    const msg = messageList[i];
    if (msg !== undefined && msg.role === 'user' && typeof msg.content === 'string') {
      return msg.content;
    }
  }
  return null;
}

/**
 * 从 ChatMessage 提取角色字符串（存入 messages.role 列）
 *
 * ModelMessage 的 role 字段是联合类型 'user' | 'assistant' | 'system' | 'tool'，
 * 直接存储便于按角色过滤查询。
 */
function extractRole(msg: ChatMessage): string {
  return msg.role;
}

/**
 * 序列化 ChatMessage 为 JSON 字符串（存入 messages.content 列）
 *
 * 完整序列化 ModelMessage（含 content / tool-call / tool-result 等字段），
 * 反序列化时通过 JSON.parse 还原。
 *
 * @throws AppError(INTERNAL_ERROR) 序列化失败（理论不会，除非循环引用）
 */
function serializeMessage(msg: ChatMessage): string {
  try {
    return JSON.stringify(msg);
  } catch (error) {
    throw new AppError(ErrorCode.INTERNAL_ERROR, '消息 JSON 序列化失败', error, { role: msg.role });
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
