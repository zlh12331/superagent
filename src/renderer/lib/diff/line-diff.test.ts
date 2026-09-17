// src/renderer/lib/diff/line-diff.test.ts
// 行级 diff 纯函数测试（dmp 行编码 + 规模守卫）
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. 基本 LCS 语义（context/add/del 排列）
// 2. 空文本边界（新建全 add / 删除全 del）
// 3. 规模守卫：超上限退化为整块替换（不串码、不丢行）
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { computeLineDiff } from './line-diff';

/** 构造 n 行文本（内容带序号，保证行唯一） */
function lines(n: number, prefix = 'L'): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join('\n');
}

describe('computeLineDiff', () => {
  it('基本 LCS：中间插入一行 → context/add/context', () => {
    expect(computeLineDiff('a\nb', 'a\nc\nb')).toEqual([
      { type: 'context', text: 'a' },
      { type: 'add', text: 'c' },
      { type: 'context', text: 'b' },
    ]);
  });

  it('删除一行 → del', () => {
    expect(computeLineDiff('a\nb', 'b')).toEqual([
      { type: 'del', text: 'a' },
      { type: 'context', text: 'b' },
    ]);
  });

  it('空 old（新建文件）→ 全 add', () => {
    expect(computeLineDiff('', 'x\ny')).toEqual([
      { type: 'add', text: 'x' },
      { type: 'add', text: 'y' },
    ]);
  });

  it('空 new（删除文件）→ 全 del', () => {
    expect(computeLineDiff('x\ny', '')).toEqual([
      { type: 'del', text: 'x' },
      { type: 'del', text: 'y' },
    ]);
  });

  it('规模守卫：任一侧超 5000 行 → 整块替换（全 del + 全 add，行文本不丢）', () => {
    const big = lines(5001);
    const result = computeLineDiff(big, 'only-one-line');
    // 退化路径：old 全 del 在前，new 全 add 在后，无 context
    expect(result).toHaveLength(5001 + 1);
    expect(result.every((line) => line.type === 'del' || line.type === 'add')).toBe(true);
    expect(result[0]).toEqual({ type: 'del', text: 'L0' });
    expect(result[5000]).toEqual({ type: 'del', text: 'L5000' });
    expect(result[5001]).toEqual({ type: 'add', text: 'only-one-line' });
  });

  it('边界：恰好 5000 行仍走精确 diff（不误触退化）', () => {
    const atLimit = lines(5000);
    const result = computeLineDiff(atLimit, atLimit);
    expect(result.every((line) => line.type === 'context')).toBe(true);
    expect(result).toHaveLength(5000);
  });
});
