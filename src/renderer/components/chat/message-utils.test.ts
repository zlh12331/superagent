// src/renderer/components/chat/message-utils.test.ts
// 聊天消息纯函数测试（状态映射 / 文本提取 / JSON 格式化）——无 DOM 依赖高杠杆
import type { TFunction } from 'i18next';

import { describe, expect, it, vi } from 'vitest';

import {
  extractText,
  formatJson,
  mapToolStateToStatusClass,
  mapToolStateToStatusLabelKey,
} from './message-utils';

/** mock TFunction（返回传入 key） */
const mockT = vi.fn((key: string) => key) as unknown as TFunction;

describe('mapToolStateToStatusLabelKey', () => {
  it('output-error → statusError', () => {
    expect(mapToolStateToStatusLabelKey('output-error')).toBe('statusError');
  });
  it('output-available → statusSuccess', () => {
    expect(mapToolStateToStatusLabelKey('output-available')).toBe('statusSuccess');
  });
  it('input-streaming / input-accepted → statusRunning', () => {
    expect(mapToolStateToStatusLabelKey('input-streaming')).toBe('statusRunning');
    expect(mapToolStateToStatusLabelKey('input-accepted')).toBe('statusRunning');
  });
  it('其他（含 undefined 派生）→ statusWaiting', () => {
    expect(mapToolStateToStatusLabelKey('whatever')).toBe('statusWaiting');
  });
});

describe('mapToolStateToStatusClass', () => {
  it('output-error → error；output-available → success', () => {
    expect(mapToolStateToStatusClass('output-error')).toBe('error');
    expect(mapToolStateToStatusClass('output-available')).toBe('success');
  });
  it('input-streaming / input-accepted → running', () => {
    expect(mapToolStateToStatusClass('input-streaming')).toBe('running');
    expect(mapToolStateToStatusClass('input-accepted')).toBe('running');
  });
  it('其他 → pending', () => {
    expect(mapToolStateToStatusClass('idle')).toBe('pending');
  });
});

describe('extractText', () => {
  it('只取 text parts，按 \\n 拼接', () => {
    const parts = [
      { type: 'text', text: '第一行' },
      { type: 'reasoning', text: '思考' },
      { type: 'text', text: '第二行' },
    ] as never;
    expect(extractText(parts)).toBe('第一行\n第二行');
  });
  it('无 text part → 空字符串', () => {
    expect(extractText([{ type: 'tool-call' } as never])).toBe('');
  });
  it('空数组 → 空字符串', () => {
    expect(extractText([])).toBe('');
  });
});

describe('formatJson', () => {
  it('正常对象 → 缩进 JSON', () => {
    expect(formatJson({ a: 1 }, mockT)).toBe('{\n  "a": 1\n}');
  });
  it('undefined → 返回字符串 undefined', () => {
    expect(formatJson(undefined, mockT)).toBe('undefined');
  });
  it('超过 200 字符 → 截断 + 附加截断标记', () => {
    const big = { data: 'x'.repeat(500) };
    const result = formatJson(big, mockT);
    expect(result.length).toBeGreaterThan(200);
    expect(result).toContain('\n…chat.truncatedJson'); // mockT 返回 key
    expect(result.slice(0, 200)).toBe(JSON.stringify(big, null, 2).slice(0, 200));
  });
  it('循环引用（JSON.stringify 抛错）→ String(value)', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    // String(circular) 会转 'self' 循环——此处只需验证不抛错且返回字符串
    expect(() => formatJson(circular, mockT)).not.toThrow();
  });
});
