// src/renderer/lib/pending-message.ts
// 欢迎页首条消息透传辅助（A1 修复）
// ──────────────────────────────────────────────────────────────
// 背景：home.tsx 创建会话后把首条消息暂存 sessionStorage（避免 ChatPanel
// 未挂载时直接 sendMessage 丢失），ChatPanel 挂载后消费并自动发送。
// 此前只有写入端、没有读取端 → 首条消息永久丢失。
// ──────────────────────────────────────────────────────────────

const WELCOME_PENDING_MESSAGE_PREFIX = 'welcome:pending-message:';

/** sessionId → sessionStorage key */
export function pendingMessageKey(sessionId: string): string {
  return WELCOME_PENDING_MESSAGE_PREFIX + sessionId;
}

/** 暂存消息有效期（毫秒）：超过则视为陈旧（应用重启/跨会话残留），丢弃不发送 */
export const PENDING_MESSAGE_TTL_MS = 10 * 60 * 1000;

/**
 * 消费暂存的首条消息（读取后立即移除，幂等：第二次调用返回 null）
 *
 * 陈旧性防护：消息携带 createdAt 时间戳，超过 PENDING_MESSAGE_TTL_MS 视为
 * 上次应用会话的残留（Electron 会持久化 sessionStorage）——自动发送陈旧消息
 * 会打断用户当前操作（幽灵发送），必须丢弃。
 *
 * @param storage 存储实现（渲染层传 sessionStorage；测试可注入内存 Map）
 * @param sessionId 会话 id
 * @returns 有效消息文本（trim 后非空），不存在/解析失败/空文本/陈旧时返回 null
 */
export function consumePendingMessage(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  sessionId: string,
): string | null {
  const key = pendingMessageKey(sessionId);
  const raw = storage.getItem(key);
  if (raw === null) return null;
  // 先移除再解析：任何解析失败都不会残留坏数据阻塞后续挂载
  storage.removeItem(key);
  try {
    const parsed = JSON.parse(raw) as { readonly text?: unknown; readonly createdAt?: unknown };
    const text = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
    if (text.length === 0) return null;
    const createdAt = typeof parsed?.createdAt === 'number' ? parsed.createdAt : 0;
    if (Date.now() - createdAt > PENDING_MESSAGE_TTL_MS) {
      return null;
    }
    return text;
  } catch {
    return null;
  }
}
