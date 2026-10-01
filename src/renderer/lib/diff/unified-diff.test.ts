// src/renderer/lib/diff/unified-diff.test.ts
// unified diff 解析器单测：hunk 拆解 / 还原 / 边界

import { describe, expect, it } from 'vitest';

import { countHunks, extractDiffTargetPath, parseUnifiedDiff } from './unified-diff';

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

  it('lines：语义化行序列（类型 + 双侧行号推算，@@ 头为基准）', () => {
    const [hunk] = parseUnifiedDiff(SAMPLE);
    expect(hunk?.lines).toEqual([
      { type: 'context', oldNumber: 1, newNumber: 1, text: 'const a = 1;' },
      { type: 'del', oldNumber: 2, newNumber: null, text: 'const b = 2;' },
      { type: 'add', oldNumber: null, newNumber: 2, text: 'const b = 3;' },
      { type: 'add', oldNumber: null, newNumber: 3, text: 'const c = 4;' },
      { type: 'context', oldNumber: 3, newNumber: 4, text: 'const d = 5;' },
    ]);
  });

  it('lines：多 hunk 时行号随 @@ 头重置（第二 hunk 从各自起始行推进）', () => {
    const diff = ['@@ -10,2 +10,2 @@', ' x', '-a', '+b', '@@ -20,1 +20,1 @@', '-c', '+d'].join(
      '\n',
    );
    const hunks = parseUnifiedDiff(diff);
    expect(hunks[0]?.lines).toEqual([
      { type: 'context', oldNumber: 10, newNumber: 10, text: 'x' },
      { type: 'del', oldNumber: 11, newNumber: null, text: 'a' },
      { type: 'add', oldNumber: null, newNumber: 11, text: 'b' },
    ]);
    expect(hunks[1]?.lines).toEqual([
      { type: 'del', oldNumber: 20, newNumber: null, text: 'c' },
      { type: 'add', oldNumber: null, newNumber: 20, text: 'd' },
    ]);
  });

  it('lines：hunk 头省略计数（@@ -5 +5 @@）同样生效', () => {
    const hunks = parseUnifiedDiff(['@@ -5 +5 @@', '-x', '+y'].join('\n'));
    expect(hunks[0]?.lines).toEqual([
      { type: 'del', oldNumber: 5, newNumber: null, text: 'x' },
      { type: 'add', oldNumber: null, newNumber: 5, text: 'y' },
    ]);
  });
});

describe('extractDiffTargetPath', () => {
  it('正向：+++ b/ 前缀剥离，返回目标路径', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1 +1 @@',
    ].join('\n');
    expect(extractDiffTargetPath(diff)).toBe('foo.ts');
  });

  it('纯删除文件（+++ /dev/null）→ null', () => {
    const diff = ['--- a/old.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@'].join('\n');
    expect(extractDiffTargetPath(diff)).toBeNull();
  });

  it('时间戳后缀（\\t 分隔）被剥离', () => {
    const diff = ['--- a/f.ts', '+++ b/f.ts\t2026-09-27 00:00:00'].join('\n');
    expect(extractDiffTargetPath(diff)).toBe('f.ts');
  });

  it('缺失 +++ 头 / 空 diff → null', () => {
    expect(extractDiffTargetPath('')).toBeNull();
    expect(extractDiffTargetPath('diff --git a/x b/x')).toBeNull();
  });

  it('CRLF 行尾解析不受影响', () => {
    expect(extractDiffTargetPath('--- a/f.ts\r\n+++ b/f.ts\r\n')).toBe('f.ts');
  });
});
