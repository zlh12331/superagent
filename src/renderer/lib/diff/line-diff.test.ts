// src/renderer/lib/diff/line-diff.test.ts
// 行级 diff 纯函数测试（dmp 行编码 + 规模守卫）
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. 基本 LCS 语义（context/add/del 排列）
// 2. 空文本边界（新建全 add / 删除全 del）
// 3. 规模守卫：超上限退化为整块替换（不串码、不丢行）
// 4. 统计（countDiffLines）
// 历史：2026-09-24 合并 __tests__/line-diff.test.ts（countDiffLines 用例并回，
// 双文件并存是当年 colocation 迁移的未收尾残留）
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { computeLineDiff, countDiffLines } from './line-diff';

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

  it('混合增删：替换一段', () => {
    const result = computeLineDiff('a\nold\nb', 'a\nnew1\nnew2\nb');
    const types = result.map((l) => l.type);
    expect(types).toContain('del');
    expect(types).toContain('add');
    expect(result.filter((l) => l.type === 'context').map((l) => l.text)).toEqual(['a', 'b']);
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

  it('文本相同 → 全量 context', () => {
    const result = computeLineDiff('a\nb', 'a\nb');
    expect(result.every((l) => l.type === 'context')).toBe(true);
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

describe('countDiffLines', () => {
  it('统计增删行数', () => {
    const result = computeLineDiff('a\nold\nb', 'a\nnew\nb');
    expect(countDiffLines(result)).toEqual({ additions: 1, deletions: 1 });
  });

  it('无变更 → 0/0', () => {
    expect(countDiffLines(computeLineDiff('a', 'a'))).toEqual({ additions: 0, deletions: 0 });
  });
});
