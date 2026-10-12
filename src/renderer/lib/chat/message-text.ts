import type { UIMessage } from 'ai';
import { isTextUIPart } from 'ai';

/** part 类型（UIMessage['parts'][number] 派生） */
type UiMessagePart = UIMessage['parts'][number];

/**
 * 提取 parts 中的文本（text part 按 \n 拼接，非文本 part 过滤）
 *
 * 消费方：消息气泡与 Markdown 输入（message-item）、导航轨预览截断
 * （use-message-nav-rail）、会话内搜索匹配（use-conversation-search）。
 *
 * @param parts 消息 parts（UIMessage['parts']）
 * @returns 拼接后的纯文本；无 text part 时为空串
 */
export function extractText(parts: readonly UiMessagePart[]): string {
  return parts
    .filter(isTextUIPart)
    .map((part) => part.text)
    .join('\n');
}
