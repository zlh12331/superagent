// src/main/infra/storage/session-helpers.ts
// SessionService 辅助函数（自 session-service.ts 提取：行转换 / 标题解析 / 消息序列化）
// ──────────────────────────────────────────────────────────────
// 全部为纯函数（不持有 DB 连接），由 SessionService 实现消费。
// ──────────────────────────────────────────────────────────────

import type { ChatMessage, SessionMeta } from '@code-agent/shared/main';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import type { MessageRole, sessions } from './schema';

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
 * 将 sessions 行转换为 SessionMeta（IPC 响应类型）
 *
 * 字段对齐：
 * - id / title / createdAt / updatedAt / messageCount 直接透传
 * - lastMessage 是 nullable text，转为 string | undefined（对齐 zod schema 推断类型）
 */
export function rowToMeta(row: typeof sessions.$inferSelect): SessionMeta {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastMessage: row.lastMessage ?? undefined,
    messageCount: row.messageCount,
    workingDir: row.workingDir,
    lastRunStatus: row.lastRunStatus as SessionMeta['lastRunStatus'],
    pinned: row.pinned === 1,
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
export function resolveTitle(
  title: string | undefined,
  messageList: readonly ChatMessage[],
  defaultTitle: string,
): string {
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
  return defaultTitle;
}

/**
 * 解析 lastMessage 预览
 *
 * 取消息历史中最后一条 user 消息内容前 100 字符。
 * 若消息历史中无 user 消息，返回 null（表示 lastMessage 字段为空）。
 */
export function resolveLastMessagePreview(messageList: readonly ChatMessage[]): string | null {
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

/** 从 ChatMessage 提取角色（与 messages.role 列的 $type<MessageRole> 对齐） */
export function extractRole(msg: ChatMessage): MessageRole {
  return msg.role as MessageRole;
}

/**
 * 序列化 ChatMessage 为 JSON 字符串（存入 messages.content 列）
 *
 * 完整序列化 ModelMessage（含 content / tool-call / tool-result 等字段），
 * 反序列化时通过 JSON.parse 还原。
 *
 * @throws AppError(INTERNAL_ERROR) 序列化失败（理论不会，除非循环引用）
 */
export function serializeMessage(msg: ChatMessage): string {
  try {
    return JSON.stringify(msg);
  } catch (error) {
    throw new AppError(ErrorCode.INTERNAL_ERROR, '消息 JSON 序列化失败', error, { role: msg.role });
  }
}
