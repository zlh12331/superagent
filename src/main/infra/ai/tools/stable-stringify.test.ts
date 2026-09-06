// src/main/infra/ai/tools/stable-stringify.test.ts
// 稳定 JSON 序列化单测：键排序 / 循环引用 / DAG 共享引用

import { describe, expect, it } from 'vitest';
import { stableStringify } from './stable-stringify';

describe('stableStringify（键按字典序排序）', () => {
  it('相同内容不同键顺序 → 相同序列化结果', () => {
    const a = stableStringify({ b: 1, a: 2, c: { y: 1, x: 2 } });
    const b = stableStringify({ c: { x: 2, y: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":{"x":2,"y":1}}');
  });

  it('非对象原样序列化（string/number/boolean/null）', () => {
    expect(stableStringify('s')).toBe('"s"');
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(undefined)).toBe(undefined);
  });

  it('数组按序保留，元素递归稳定化', () => {
    expect(stableStringify([{ b: 1, a: 2 }, 3])).toBe('[{"a":2,"b":1},3]');
  });

  it('循环引用抛 TypeError（与 JSON.stringify 一致，非无限递归）', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj['self'] = obj;
    expect(() => stableStringify(obj)).toThrow(TypeError);
  });

  it('共享引用（DAG）不误判为循环引用', () => {
    // {a: shared, b: shared} 是 DAG 而非环，原生 JSON.stringify 可序列化
    const shared = { x: 1 };
    const result = stableStringify({ a: shared, b: shared });
    expect(result).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});
