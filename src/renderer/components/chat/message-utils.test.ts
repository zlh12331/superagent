// src/renderer/components/chat/message-utils.test.ts
// 工具卡展示纯函数测试（状态映射 / JSON 格式化）——无 DOM 依赖高杠杆
// extractText 的测试已随实现迁至 lib/chat/message-text.test.ts（2026-09-15）
import type { TFunction } from 'i18next';

import { describe, expect, it, vi } from 'vitest';

import {
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
  it('input-streaming / input-available / approval-responded → statusRunning', () => {
    expect(mapToolStateToStatusLabelKey('input-streaming')).toBe('statusRunning');
    expect(mapToolStateToStatusLabelKey('input-available')).toBe('statusRunning');
    expect(mapToolStateToStatusLabelKey('approval-responded')).toBe('statusRunning');
  });
  it('approval-requested / output-denied → statusWaiting（未产出）', () => {
    expect(mapToolStateToStatusLabelKey('approval-requested')).toBe('statusWaiting');
    expect(mapToolStateToStatusLabelKey('output-denied')).toBe('statusWaiting');
  });
});

describe('mapToolStateToStatusClass', () => {
  it('output-error → error；output-available → success', () => {
    expect(mapToolStateToStatusClass('output-error')).toBe('error');
    expect(mapToolStateToStatusClass('output-available')).toBe('success');
  });
  it('input-streaming / input-available / approval-responded → running', () => {
    expect(mapToolStateToStatusClass('input-streaming')).toBe('running');
    expect(mapToolStateToStatusClass('input-available')).toBe('running');
    expect(mapToolStateToStatusClass('approval-responded')).toBe('running');
  });
  it('approval-requested / output-denied → pending', () => {
    expect(mapToolStateToStatusClass('approval-requested')).toBe('pending');
    expect(mapToolStateToStatusClass('output-denied')).toBe('pending');
  });
});

describe('状态映射表完整性（单一真源不变量）', () => {
  // label 与 class 收敛到同一张 Record 后，两条映射必须对**每个** ToolCallState
  // 都给出一致的分组（此前是两条平行 if 阶梯，新增状态只改一处会静默漂移）。
  const AllStates = [
    'input-streaming',
    'input-available',
    'approval-requested',
    'approval-responded',
    'output-available',
    'output-error',
    'output-denied',
  ] as const;

  it('每个状态都有定义（无 undefined 漏网）', () => {
    for (const state of AllStates) {
      expect(mapToolStateToStatusLabelKey(state)).toBeTypeOf('string');
      expect(mapToolStateToStatusClass(state)).toBeTypeOf('string');
    }
  });

  it('label 分组与 class 分组一一对应', () => {
    const expected: Record<string, string> = {
      statusError: 'error',
      statusSuccess: 'success',
      statusRunning: 'running',
      statusWaiting: 'pending',
    };
    for (const state of AllStates) {
      expect(expected[mapToolStateToStatusLabelKey(state)]).toBe(mapToolStateToStatusClass(state));
    }
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
