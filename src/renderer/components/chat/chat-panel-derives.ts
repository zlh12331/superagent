// src/renderer/components/chat/chat-panel-derives.ts
// ChatPanel 纯派生：状态指示文本 + 历史回显能力缺口告知（自 ChatPanel 提取）
// ──────────────────────────────────────────────
// 为什么提出来：两者都是「输入确定 → 输出确定」的映射，留在组件里既撑长函数体，
// 又要连带挂载 useChat / IPC / TanStack Query 才能验证分支，实测成本与收益不成比例。

import type { TFunction } from 'i18next';
import type { ReconstructedHistory } from './history-parts';

/**
 * useChat 状态 → 状态条右侧指示文本
 *
 * 刻意保留大写英文原样：状态条是调试信息位（与参考项目一致），不做本地化包装，
 * 避免用户看到的 "THINKING" 被翻译成与源码状态机脱节的措辞。
 */
export function statusLabel(status: string): string {
  if (status === 'streaming') return 'RUNNING';
  if (status === 'submitted') return 'THINKING';
  if (status === 'ready') return 'READY';
  if (status === 'error') return 'ERROR';
  return 'IDLE';
}

/**
 * 历史回显能力缺口清单（如实告知，不假装历史完整）
 *
 * - 落库仅存文本 → 工具调用 / 推理在重开会话后无法恢复
 * - 存储中存在但渲染层无对应回显形态的 part 类型 → 逐类列出
 */
export function collectHistoryNotices(
  history: Pick<ReconstructedHistory, 'messages' | 'hasRichParts' | 'droppedPartTypes'>,
  t: TFunction,
): string[] {
  const notices: string[] = [];
  const hasAssistantText = history.messages.some((m) => m.role === 'assistant');
  if (hasAssistantText && !history.hasRichParts) {
    notices.push(t('chat.historyTextOnly'));
  }
  if (history.droppedPartTypes.length > 0) {
    notices.push(t('chat.historyDroppedParts', { types: history.droppedPartTypes.join(' / ') }));
  }
  return notices;
}
