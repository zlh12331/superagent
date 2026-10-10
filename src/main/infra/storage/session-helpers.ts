import type { ChatMessage, SessionMeta } from '@code-agent/shared/main';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import type { MessageRole, sessions } from './schema';

const TITLE_MAX_LENGTH = 100;

const TITLE_PREVIEW_LENGTH = 50;

const LAST_MESSAGE_PREVIEW_LENGTH = 100;

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
