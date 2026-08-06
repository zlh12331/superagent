// src/renderer/lib/diff/__tests__/line-diff.test.ts
// 行级 diff 渲染数据单测：增删/上下文/空文本边界/统计

import { describe, expect, it } from 'vitest';
import { computeLineDiff, countDiffLines } from '../line-diff';

describe('computeLineDiff', () => {
  it('新增行：插入中间位置', () => {
    const lines = computeLineDiff('a\nb', 'a\nc\nb');
    expect(lines).toEqual([
      { type: 'context', text: 'a' },
      { type: 'add', text: 'c' },
      { type: 'context', text: 'b' },
    ]);
  });

  it('删除行：移除中间位置', () => {
    const lines = computeLineDiff('a\nc\nb', 'a\nb');
    expect(lines).toEqual([
      { type: 'context', text: 'a' },
      { type: 'del', text: 'c' },
      { type: 'context', text: 'b' },
    ]);
  });

  it('混合增删：替换一段', () => {
    const lines = computeLineDiff('a\nold\nb', 'a\nnew1\nnew2\nb');
    const types = lines.map((l) => l.type);
    expect(types).toContain('del');
    expect(types).toContain('add');
    expect(lines.filter((l) => l.type === 'context').map((l) => l.text)).toEqual(['a', 'b']);
  });

  it('旧文本为空（新建文件）→ 全量 add', () => {
    const lines = computeLineDiff('', 'x\ny');
    expect(lines).toEqual([
      { type: 'add', text: 'x' },
      { type: 'add', text: 'y' },
    ]);
  });

  it('新文本为空（删除文件）→ 全量 del', () => {
    const lines = computeLineDiff('x\ny', '');
    expect(lines).toEqual([
      { type: 'del', text: 'x' },
      { type: 'del', text: 'y' },
    ]);
  });

  it('文本相同 → 全量 context', () => {
    const lines = computeLineDiff('a\nb', 'a\nb');
    expect(lines.every((l) => l.type === 'context')).toBe(true);
  });
});

describe('countDiffLines', () => {
  it('统计增删行数', () => {
    const lines = computeLineDiff('a\nold\nb', 'a\nnew\nb');
    const stats = countDiffLines(lines);
    expect(stats).toEqual({ additions: 1, deletions: 1 });
  });

  it('无变更 → 0/0', () => {
    const lines = computeLineDiff('a', 'a');
    expect(countDiffLines(lines)).toEqual({ additions: 0, deletions: 0 });
  });
});
