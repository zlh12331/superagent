// session-helpers.ts：会话行/消息的纯函数工具——行转 Meta、标题与预览推导、消息序列化
// 无状态（不碰 DB），供 session-service 与测试共用
import type { ChatMessage, SessionMeta } from '@code-agent/shared/main';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import type { MessageRole, sessions } from './schema';

// 标题/预览长度档：标题截 100（防超长粘贴当标题）、首条用户消息取前 50 作默认标题、
// 列表预览取最后一条用户消息前 100
const TITLE_MAX_LENGTH = 100;

const TITLE_PREVIEW_LENGTH = 50;

const LAST_MESSAGE_PREVIEW_LENGTH = 100;

/** DB 行 → 列表 Meta（pinned 0/1 → boolean） */
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

/** 标题推导：显式标题（截 100）→ 首条用户消息前 50 → 默认标题 */
export function resolveTitle(
  title: string | undefined,
  messageList: readonly ChatMessage[],
  defaultTitle: string,
): string {
  if (title !== undefined && title.length > 0) {
    return title.length > TITLE_MAX_LENGTH ? title.slice(0, TITLE_MAX_LENGTH) : title;
  }

  const firstUserContent = findFirstUserText(messageList);
  if (firstUserContent !== null) {
    const preview =
      firstUserContent.length > TITLE_PREVIEW_LENGTH
        ? firstUserContent.slice(0, TITLE_PREVIEW_LENGTH)
        : firstUserContent;
    return preview;
  }

  return defaultTitle;
}

/** 列表预览：最后一条用户文本消息前 100 字符（assistant/tool 回复不进预览） */
export function resolveLastMessagePreview(messageList: readonly ChatMessage[]): string | null {
  const lastUserContent = findLastUserText(messageList);
  if (lastUserContent === null) {
    return null;
  }
  return lastUserContent.length > LAST_MESSAGE_PREVIEW_LENGTH
    ? lastUserContent.slice(0, LAST_MESSAGE_PREVIEW_LENGTH)
    : lastUserContent;
}

function findFirstUserText(messageList: readonly ChatMessage[]): string | null {
  for (const msg of messageList) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      return msg.content;
    }
  }
  return null;
}

function findLastUserText(messageList: readonly ChatMessage[]): string | null {
  for (let i = messageList.length - 1; i >= 0; i -= 1) {
    const msg = messageList[i];
    if (msg !== undefined && msg.role === 'user' && typeof msg.content === 'string') {
      return msg.content;
    }
  }
  return null;
}

export function extractRole(msg: ChatMessage): MessageRole {
  return msg.role as MessageRole;
}

export function serializeMessage(msg: ChatMessage): string {
  try {
    return JSON.stringify(msg);
  } catch (error) {
    throw new AppError(ErrorCode.INTERNAL_ERROR, '消息 JSON 序列化失败', error, { role: msg.role });
  }
}
