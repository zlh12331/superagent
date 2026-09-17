// src/renderer/lib/chat/message-text.ts
// 消息文本提取（UIMessage parts → 纯文本）· chat 领域跨特性共享的纯函数
// ──────────────────────────────────────────────────────────────
// 为什么放 lib/chat 而非 components/chat（2026-09-15 结构审计）：
// 本函数有三个消费方，跨两个特性边界——components/chat（message-item /
// use-message-nav-rail）与 hooks/use-conversation-search。若继续留在
// components/chat/message-utils，则 hooks → 特性内部实现文件形成目录级循环
// （ChatPanel → hooks/use-conversation-search → components/chat/message-utils），
// 违反「共享层不得反向依赖特性实现」的方向约束。
// lib/{agent,diff,query} 为先例：领域纯逻辑 + colocated 测试。
// ─────────────────────────────────────────────────────────────

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
