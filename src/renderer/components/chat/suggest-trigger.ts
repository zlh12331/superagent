// src/renderer/components/chat/suggest-trigger.ts
// 斜杠/提及建议触发检测（自 ChatInput 提取的纯函数层）
// ──────────────────────────────────────────────
// 照搬参考项目 useSlashSuggest 触发语义：支持任意位置触发，/ 与 @ 取位置靠后者；
// 触发条件：查询段无空格；slash 查询 ≤20 字符、mention 查询 ≤30 字符（允许空串）。
// ──────────────────────────────────────────────

/** 激活的建议类型 */
export type SuggestTrigger = 'slash' | 'mention';

/** slash 查询段长度上限 */
const SLASH_QUERY_MAX = 20;
/** mention 查询段长度上限 */
const MENTION_QUERY_MAX = 30;

export interface SuggestTriggerState {
  /** '/' 触发位置（无则为 -1） */
  readonly slashIndex: number;
  /** '@' 触发位置（无则为 -1） */
  readonly atIndex: number;
  /** 激活的建议类型（两者并存取位置靠后者；均未触发为 null） */
  readonly activeTrigger: SuggestTrigger | null;
  /** 激活建议的查询段（触发词之后的文本；未触发为 null） */
  readonly activeQuery: string | null;
}

/** 查询段有效性：非 null 且不含空格且不超上限 */
function isQueryActive(query: string | null, max: number): boolean {
  return query !== null && query.length <= max && !query.includes(' ');
}

/**
 * 检测输入值中的建议触发状态（纯函数）
 *
 * @param value 输入框当前文本
 */
export function detectSuggestTrigger(value: string): SuggestTriggerState {
  const slashIndex = value.lastIndexOf('/');
  const atIndex = value.lastIndexOf('@');
  const slashQuery = slashIndex >= 0 ? value.slice(slashIndex + 1) : null;
  const mentionQuery = atIndex >= 0 ? value.slice(atIndex + 1) : null;
  const slashActive = slashIndex > atIndex && isQueryActive(slashQuery, SLASH_QUERY_MAX);
  const mentionActive = atIndex > slashIndex && isQueryActive(mentionQuery, MENTION_QUERY_MAX);
  const activeTrigger = slashActive ? 'slash' : mentionActive ? 'mention' : null;
  // 未触发时查询段必须为 null（此前回落到 mentionQuery：输入 "hi @ " 这类
  // 「触发词在但查询段非法」的文本会返回非 null 的 ' '，违反接口契约）
  const activeQuery =
    activeTrigger === 'slash' ? slashQuery : activeTrigger === 'mention' ? mentionQuery : null;
  return {
    slashIndex,
    atIndex,
    activeTrigger,
    activeQuery,
  };
}
