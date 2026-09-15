// src/renderer/lib/chat/message-text.test.ts
// extractText 单测：文本拼接 / 非文本过滤 / 边界（空数组、全非文本、空文本 part）
import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';

import { extractText } from './message-text';

/** 以最小结构构造 parts（仅 type/text 参与提取逻辑） */
const parts = (...items: Array<{ type: string; text?: string }>): UIMessage['parts'] =>
  items as unknown as UIMessage['parts'];

describe('extractText', () => {
  it('正向：多个 text part 按 \\n 拼接', () => {
    expect(
      extractText(parts({ type: 'text', text: '第一行' }, { type: 'text', text: '第二行' })),
    ).toBe('第一行\n第二行');
  });

  it('正向：非文本 part 被过滤（reasoning / tool / file 不进入文本）', () => {
    expect(
      extractText(
        parts(
          { type: 'text', text: '正文' },
          { type: 'reasoning', text: '思考' },
          { type: 'tool-call' },
          { type: 'file' },
        ),
      ),
    ).toBe('正文');
  });

  it('边界：空数组 → 空串', () => {
    expect(extractText([])).toBe('');
  });

  it('边界：全为非文本 part → 空串', () => {
    expect(extractText(parts({ type: 'tool-call' }, { type: 'step-start' }))).toBe('');
  });

  it('边界（现状行为）：空 text part 参与 join，产生空行分隔', () => {
    // 记录既有语义：filter 只按类型过滤，不排除空串文本
    expect(extractText(parts({ type: 'text', text: '' }, { type: 'text', text: 'a' }))).toBe('\na');
  });
});
