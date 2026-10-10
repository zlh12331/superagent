/** 暂存记录：文本 + 写入时间（消费方据此做过期判定） */
export interface PendingMessageRecord {
  readonly text: string;
  readonly createdAt: number;
}

/** 暂存消息有效期（毫秒）：超过则视为陈旧残留，丢弃不发送 */
export const PENDING_MESSAGE_TTL_MS = 10 * 60 * 1000;

/**
 * 解析暂存记录 → 可自动发送的文本
 *
 * 陈旧性防护：自动发送会打断用户当前操作（幽灵发送），因此过期记录一律丢弃。
 *
 * @param record 暂存记录（undefined = 未暂存）
 * @param now 当前时间戳（测试可注入）
 * @returns trim 后非空且未过期的文本，否则 null
 */
export function resolvePendingMessage(
  record: PendingMessageRecord | undefined,
  now: number = Date.now(),
): string | null {
  if (record === undefined) return null;
  if (now - record.createdAt > PENDING_MESSAGE_TTL_MS) return null;
  const text = record.text.trim();
  return text.length > 0 ? text : null;
}
