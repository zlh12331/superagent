/** 激活的建议类型 */
export type SuggestTrigger = 'slash' | 'mention';

/** slash 查询段长度上限 */
const SLASH_QUERY_MAX = 20;
/** mention 查询段长度上限 */
const MENTION_QUERY_MAX = 30;

/** composer 建议触发态：'/' 斜杠命令与 '@' 文件提及的解析结果（互斥取靠后） */
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
  const activeQuery =
    activeTrigger === 'slash' ? slashQuery : activeTrigger === 'mention' ? mentionQuery : null;
  return {
    slashIndex,
    atIndex,
    activeTrigger,
    activeQuery,
  };
}
