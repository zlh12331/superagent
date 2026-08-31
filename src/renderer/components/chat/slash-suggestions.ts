// src/renderer/components/chat/slash-suggestions.ts
// 斜杠命令建议表 + 过滤（自 ChatInput 提取：数据与纯函数独立可测）
// ──────────────────────────────────────────────
// 对齐参考项目 useSlashSuggest：命令可执行（action）而非仅填充文本。
// 消费方：ChatInput（下拉渲染 + 键盘应用）、ChatPanel（经 executeSlashCommand 执行）。
// ──────────────────────────────────────────────

/** 斜杠命令动作（对齐参考项目：命令可执行而非仅填充文本） */
export type SlashAction =
  | 'new'
  | 'clear'
  | 'compact'
  | 'models'
  | 'help'
  | 'interrupt'
  | 'goal'
  | 'demo'
  | 'limit';

/** 斜杠建议项：有 action 时点击执行动作；无 action 时填充文本 */
export interface SlashSuggestion {
  readonly command: string;
  readonly labelKey: string;
  readonly action?: SlashAction;
}

/** 内置斜杠命令清单（顺序 = 下拉展示顺序） */
export const SLASH_SUGGESTIONS: readonly SlashSuggestion[] = [
  { command: '/help', labelKey: 'chat.slashSuggest.help', action: 'help' },
  { command: '/new', labelKey: 'chat.slashSuggest.newChat', action: 'new' },
  { command: '/clear', labelKey: 'chat.slashSuggest.clear', action: 'clear' },
  { command: '/compact', labelKey: 'chat.slashSuggest.compact', action: 'compact' },
  { command: '/models', labelKey: 'chat.slashSuggest.models', action: 'models' },
  // 对齐参考项目 SLASH_CMD_DEFS：/interrupt 即时中断（ChatPanel 调 stop）、/goal toast 引导
  { command: '/interrupt', labelKey: 'chat.slashSuggest.interrupt', action: 'interrupt' },
  { command: '/goal', labelKey: 'chat.slashSuggest.goal', action: 'goal' },
  // mock 演示命令（前端开发专用）：/demo 全类型消息演示、/limit 限流横幅
  { command: '/demo', labelKey: 'chat.slashSuggest.demo', action: 'demo' },
  { command: '/limit', labelKey: 'chat.slashSuggest.limit', action: 'limit' },
];

/**
 * 按查询词过滤斜杠建议（纯函数）
 *
 * command 带 '/' 前缀，查询词不含 '/'（对齐参考项目 useSlashSuggest 语义）：
 * 输入 "/co" → 查询词 "co" → 匹配 /compact。
 *
 * @param query 触发词后的查询段（如 "/co" 传入 "co"；空串匹配全部）
 */
export function filterSlashSuggestions(query: string): readonly SlashSuggestion[] {
  return SLASH_SUGGESTIONS.filter((s) => s.command.slice(1).startsWith(query));
}

/** 按命令名查找建议项（applySuggestion 回查 action 用） */
export function findSlashSuggestion(command: string): SlashSuggestion | undefined {
  return SLASH_SUGGESTIONS.find((s) => s.command === command);
}
