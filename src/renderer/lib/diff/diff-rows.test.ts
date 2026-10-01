// src/renderer/lib/diff/diff-rows.test.ts
// diff 渲染行装配单测：文本对 → 编号行（rowsFromTextPair）/ 词级片段（computeWordSegments）

import { describe, expect, it } from 'vitest';

import { computeWordSegments, rowsFromTextPair } from './diff-rows';

describe('rowsFromTextPair', () => {
  it('正向：行级对齐 + 双侧行号推进（context 双侧递增，add 只进 new）', () => {
    const rows = rowsFromTextPair('a\nb', 'a\nc\nb');
    expect(rows).toEqual([
      { type: 'context', oldNumber: 1, newNumber: 1, text: 'a' },
      { type: 'add', oldNumber: null, newNumber: 2, text: 'c' },
      { type: 'context', oldNumber: 2, newNumber: 3, text: 'b' },
    ]);
  });

  it('del 行：oldNumber 递进，newNumber 为 null', () => {
    const rows = rowsFromTextPair('x\ny\nz', 'x\nz');
    expect(rows).toEqual([
      { type: 'context', oldNumber: 1, newNumber: 1, text: 'x' },
      { type: 'del', oldNumber: 2, newNumber: null, text: 'y' },
      { type: 'context', oldNumber: 3, newNumber: 2, text: 'z' },
    ]);
  });

  it('边界：空 oldText = 新建文件（全 add）', () => {
    const rows = rowsFromTextPair('', 'l1\nl2');
    expect(rows).toEqual([
      { type: 'add', oldNumber: null, newNumber: 1, text: 'l1' },
      { type: 'add', oldNumber: null, newNumber: 2, text: 'l2' },
    ]);
  });

  it('边界：空 newText = 删除文件（全 del）', () => {
    const rows = rowsFromTextPair('l1\nl2', '');
    expect(rows).toEqual([
      { type: 'del', oldNumber: 1, newNumber: null, text: 'l1' },
      { type: 'del', oldNumber: 2, newNumber: null, text: 'l2' },
    ]);
  });
});

describe('computeWordSegments', () => {
  it('正向：片段按序拼接还原两侧原文，且含变更词', () => {
    const segments = computeWordSegments('const a = 1;', 'const a = 2;');
    const delSide = segments
      .filter((s) => s.type !== 'add')
      .map((s) => s.text)
      .join('');
    const addSide = segments
      .filter((s) => s.type !== 'del')
      .map((s) => s.text)
      .join('');
    expect(delSide).toBe('const a = 1;');
    expect(addSide).toBe('const a = 2;');
    expect(segments.some((s) => s.type === 'del')).toBe(true);
    expect(segments.some((s) => s.type === 'add')).toBe(true);
  });

  it('完全相同的行：只有 equal 片段', () => {
    const segments = computeWordSegments('same line', 'same line');
    expect(segments.every((s) => s.type === 'equal')).toBe(true);
  });

  it('超长守卫：任一行超过 2000 字符 → 空数组（退化为整行渲染）', () => {
    const longLine = 'x'.repeat(2001);
    expect(computeWordSegments(longLine, 'y')).toEqual([]);
    expect(computeWordSegments('y', longLine)).toEqual([]);
  });
});
