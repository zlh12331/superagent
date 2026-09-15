// message-utils.ts（自 ChatMessageList 拆分）
// 聊天消息纯函数：状态映射 / 文本提取 / JSON 格式化
// ──────────────────────────────
// 拆分背景：ChatMessageList 685 行，纯函数与组件混合，按职责提取
// ──────────────────────────────

import type { UIMessage } from 'ai';
import { isTextUIPart } from 'ai';
import type { TFunction } from 'i18next';

/** part 类型（UIMessage['parts'][number] 派生） */
type UiMessagePart = UIMessage['parts'][number];

/**
 * 工具状态对应的本地化键（chat.* 域）
 *
 * 收窄为字面量联合：键名与 i18n 资源一一对应，拼错即编译失败（此前返回裸 string）
 */
export type ToolStatusLabelKey =
  | 'statusError'
  | 'statusSuccess'
  | 'statusRunning'
  | 'statusWaiting';

/** 工具状态对应的卡片状态类（CSS .card-status.<x>） */
export type ToolStatusClass = 'error' | 'success' | 'running' | 'pending';

export function mapToolStateToStatusLabelKey(state: string): ToolStatusLabelKey {
  if (state === 'output-error') {
    return 'statusError';
  }
  if (state === 'output-available') {
    return 'statusSuccess';
  }
  if (state === 'input-streaming' || state === 'input-accepted') {
    return 'statusRunning';
  }
  return 'statusWaiting';
}

/**
 * 工具状态映射 → .card-status 类名
 *
 * AI SDK 的 tool.state 可能值：
 * - 'input-streaming' / 'input-accepted'：输入阶段（pending）
 * - 'output-available'：完成（success）
 * - 'output-error'：错误（error）
 */
export function mapToolStateToStatusClass(state: string): ToolStatusClass {
  if (state === 'output-error') {
    return 'error';
  }
  if (state === 'output-available') {
    return 'success';
  }
  if (state === 'input-streaming' || state === 'input-accepted') {
    return 'running';
  }
  return 'pending';
}

/**
 * 代码块（带标签 + 内容）
 *
 * 用于展示工具调用的 input / output / error。
 */

export function extractText(parts: readonly UiMessagePart[]): string {
  return parts
    .filter(isTextUIPart)
    .map((part) => part.text)
    .join('\n');
}

/**
 * JSON 序列化（截断到 200 字符，避免大对象撑爆 UI）
 */
export function formatJson(value: unknown, t: TFunction): string {
  try {
    const json = JSON.stringify(value, null, 2) ?? 'undefined';
    return json.length > 200 ? `${json.slice(0, 200)}\n…${t('chat.truncatedJson')}` : json;
  } catch {
    return String(value);
  }
}
