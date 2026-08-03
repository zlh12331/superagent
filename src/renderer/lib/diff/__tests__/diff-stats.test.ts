// src/renderer/lib/diff/__tests__/diff-stats.test.ts
// diff-stats 单测：diff-match-patch 行级语义统计
import { describe, expect, it } from 'vitest';

import { countSemanticDiffLines } from '../diff-stats';

describe('countSemanticDiffLines', () => {
  it('空 diff：0/0', () => {
    expect(countSemanticDiffLines('')).toEqual({ additions: 0, deletions: 0 });
  });

  it('无 +/- 行（仅文件头）：0/0', () => {
    const diff = [
      'diff --git a/src/x.ts b/src/x.ts',
      'index 123..456 100644',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -0,0 +0,0 @@',
    ].join('\n');
    expect(countSemanticDiffLines(diff)).toEqual({ additions: 0, deletions: 0 });
  });

  it('纯新增行：additions=2', () => {
    const diff = [
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,0 +1,2 @@',
      '+const a = 1;',
      '+const b = 2;',
    ].join('\n');
    expect(countSemanticDiffLines(diff)).toEqual({ additions: 2, deletions: 0 });
  });

  it('纯删除行：deletions=2', () => {
    const diff = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +0,0 @@', '-old line 1', '-old line 2'].join(
      '\n',
    );
    expect(countSemanticDiffLines(diff)).toEqual({ additions: 0, deletions: 2 });
  });

  it('混合修改：+2 -1', () => {
    const diff = [
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,4 @@',
      '-removed',
      '+added1',
      '+added2',
      ' same',
    ].join('\n');
    const result = countSemanticDiffLines(diff);
    expect(result.deletions).toBe(1);
    expect(result.additions).toBe(2);
  });

  it('忽略 +++/---/@@/diff/index 行（不误计）', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      'index abc..def 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1 +1 @@',
      '+new',
    ].join('\n');
    expect(countSemanticDiffLines(diff)).toEqual({ additions: 1, deletions: 0 });
  });
});
