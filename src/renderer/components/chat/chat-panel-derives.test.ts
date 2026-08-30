// src/renderer/components/chat/chat-panel-derives.test.ts
// ChatPanel 纯派生单测：状态文本映射 + 历史回显缺口告知

import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import { collectHistoryNotices, statusLabel } from './chat-panel-derives';

/** t 桩：回显 key（+ 插值参数），断言「哪几条告知被选中」而非具体文案 */
const t = ((key: string, params?: unknown) =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`) as unknown as TFunction;

describe('statusLabel', () => {
  it.each([
    ['streaming', 'RUNNING'],
    ['submitted', 'THINKING'],
    ['ready', 'READY'],
    ['error', 'ERROR'],
    ['idle', 'IDLE'],
  ])('%s → %s', (status, expected) => {
    expect(statusLabel(status)).toBe(expected);
  });
});

describe('collectHistoryNotices', () => {
  const assistant = { id: 'a1', role: 'assistant', parts: [] } as never;

  it('空历史不提示（新会话不该看到能力缺口文案）', () => {
    expect(
      collectHistoryNotices({ messages: [], hasRichParts: false, droppedPartTypes: [] }, t),
    ).toEqual([]);
  });

  it('仅文本的 assistant 历史 → 提示只剩文本', () => {
    const notices = collectHistoryNotices(
      { messages: [assistant], hasRichParts: false, droppedPartTypes: [] },
      t,
    );
    expect(notices).toEqual(['chat.historyTextOnly']);
  });

  it('有富 part 回显时不提示只剩文本，但登记被丢弃的类型', () => {
    const notices = collectHistoryNotices(
      { messages: [assistant], hasRichParts: true, droppedPartTypes: ['file', 'reasoning'] },
      t,
    );
    expect(notices).toEqual(['chat.historyDroppedParts:{"types":"file / reasoning"}']);
  });

  it('文本缺失与类型丢弃可并存且顺序稳定', () => {
    const notices = collectHistoryNotices(
      { messages: [assistant], hasRichParts: false, droppedPartTypes: ['file'] },
      t,
    );
    expect(notices).toEqual(['chat.historyTextOnly', 'chat.historyDroppedParts:{"types":"file"}']);
  });
});
