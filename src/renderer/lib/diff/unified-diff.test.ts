// src/renderer/lib/diff/unified-diff.test.ts
// unified diff 解析器单测：hunk 拆解 / 还原 / 边界

import { describe, expect, it } from 'vitest';

import { countHunks, parseUnifiedDiff } from './unified-diff';

const SAMPLE = [
  'diff --git a/foo.ts b/foo.ts',
  'index 111..222 100644',
  '--- a/foo.ts',
  '+++ b/foo.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' const d = 5;',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('基础：解析出单个 hunk，上下文进入两侧、增删行分侧', () => {
    const hunks = parseUnifiedDiff(SAMPLE);
    expect(hunks).toHaveLength(1);
    const [hunk] = hunks;
    expect(hunk?.oldStart).toBe(1);
    expect(hunk?.newStart).toBe(1);
    expect(hunk?.oldLines).toEqual(['const a = 1;', 'const b = 2;', 'const d = 5;']);
    expect(hunk?.newLines).toEqual([
      'const a = 1;',
      'const b = 3;',
      'const c = 4;',
      'const d = 5;',
    ]);
  });

  it('多 hunk：按 @@ 头拆分为多个', () => {
    const diff = [
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -10,2 +10,2 @@',
      ' x',
      '-a',
      '+b',
      '@@ -20,1 +20,1 @@',
      '-c',
      '+d',
    ].join('\n');
    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.oldStart).toBe(10);
    // 上下文行 'x' 同时进入两侧（首个 hunk：x/a → x/b）
    expect(hunks[0]?.oldLines).toEqual(['x', 'a']);
    expect(hunks[0]?.newLines).toEqual(['x', 'b']);
    expect(hunks[1]?.oldStart).toBe(20);
    expect(hunks[1]?.oldLines).toEqual(['c']);
    expect(hunks[1]?.newLines).toEqual(['d']);
  });

  it('纯新增文件：oldLines 为空', () => {
    const diff = ['--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1,2 @@', '+line1', '+line2'].join(
      '\n',
    );
    const hunks = parseUnifiedDiff(diff);
    expect(hunks[0]?.oldLines).toEqual([]);
    expect(hunks[0]?.newLines).toEqual(['line1', 'line2']);
    expect(hunks[0]?.oldStart).toBe(0);
  });

  it('纯删除文件：newLines 为空', () => {
    const diff = ['--- a/old.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-line1', '-line2'].join(
      '\n',
    );
    const hunks = parseUnifiedDiff(diff);
    expect(hunks[0]?.oldLines).toEqual(['line1', 'line2']);
    expect(hunks[0]?.newLines).toEqual([]);
  });

  it('忽略 \\ No newline 标记与 hunk 外头行', () => {
    const diff = [
      'diff --git a/x b/x',
      'index 1..2 100644',
      '--- a/x',
      '+++ b/x',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
      '\\ No newline at end of file',
    ].join('\n');
    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.oldLines).toEqual(['old']);
    expect(hunks[0]?.newLines).toEqual(['new']);
  });

  it('无 hunk（空 diff / 仅头部）：返回空数组', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('diff --git a/x b/x\nindex 1..2 100644')).toEqual([]);
  });

  it('CRLF 行尾：解析不受影响', () => {
    const diff = '@@ -1,1 +1,1 @@\r\n-old\r\n+new\r\n';
    const hunks = parseUnifiedDiff(diff);
    expect(hunks[0]?.oldLines).toEqual(['old']);
    expect(hunks[0]?.newLines).toEqual(['new']);
  });

  it('countHunks：统计 hunk 数量', () => {
    expect(countHunks(SAMPLE)).toBe(1);
    expect(countHunks('')).toBe(0);
  });
});
