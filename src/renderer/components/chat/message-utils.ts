// message-utils.ts
// 工具卡展示纯函数：状态映射（ToolCallState → 类名/文案键）+ JSON 预览格式化
// ──────────────────────────────
// 自 ChatMessageList 拆分；extractText 已于 2026-09-15 迁至 lib/chat/message-text.ts
// （跨特性共享，留在本文件会形成 hooks → 特性内部实现的目录级循环）
// ──────────────────────────────

import type { TFunction } from 'i18next';

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

/**
 * 工具调用状态联合（对齐 ai 包 ToolUIPart / DynamicToolUIPart 的 state：
 * input-streaming / input-available / approval-requested / approval-responded /
 * output-available / output-error / output-denied）
 *
 * 注意：不存在 'input-accepted'（2026-09-15 核实 ai 包类型后删除该死分支——
 * 此前 input-available 落入 waiting 兜底，工具执行中 spinner 不转）
 */
export type ToolCallState =
  | 'input-streaming'
  | 'input-available'
  | 'approval-requested'
  | 'approval-responded'
  | 'output-available'
  | 'output-error'
  | 'output-denied';

export function mapToolStateToStatusLabelKey(state: ToolCallState): ToolStatusLabelKey {
  if (state === 'output-error') {
    return 'statusError';
  }
  if (state === 'output-available') {
    return 'statusSuccess';
  }
  // running：参数流式传输中 / 已就绪执行中 / 审批已通过待产出
  if (
    state === 'input-streaming' ||
    state === 'input-available' ||
    state === 'approval-responded'
  ) {
    return 'statusRunning';
  }
  // approval-requested（等用户审批）/ output-denied（用户拒绝，未产出）→ waiting
  return 'statusWaiting';
}

/**
 * 工具状态映射 → .card-status 类名
 *
 * AI SDK 的 tool.state 可能值见 {@link ToolCallState}。
 */
export function mapToolStateToStatusClass(state: ToolCallState): ToolStatusClass {
  if (state === 'output-error') {
    return 'error';
  }
  if (state === 'output-available') {
    return 'success';
  }
  if (
    state === 'input-streaming' ||
    state === 'input-available' ||
    state === 'approval-responded'
  ) {
    return 'running';
  }
  return 'pending';
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
