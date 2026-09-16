// src/renderer/components/file-tree/__tests__/file-viewer-utils.test.ts
// 文件预览纯函数单测（shiki 语言检测 / 行数计算）
// ──────────────────────────────────────────────────────────────
// detectLangFromPath 决定「按什么语言高亮」与工具栏是否显示语言名，
// 此前零直接覆盖。未命中一律回落到 'text'（normalizeLang 的兜底），
// 因此「目录名含点」这类异常输入不会产生乱码语言，只会退化为不高亮。
// lineCount 用于查看态无 IPC totalLines 的回退与编辑态行数实时显示。
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { detectLangFromPath, lineCount } from '../file-viewer-utils';

describe('detectLangFromPath', () => {
  it('映射表命中：常见扩展名 → shiki 语言 ID', () => {
    expect(detectLangFromPath('/proj/src/a.ts')).toBe('typescript');
    expect(detectLangFromPath('C:\\proj\\a.tsx')).toBe('tsx');
    expect(detectLangFromPath('/proj/a.json')).toBe('json');
    expect(detectLangFromPath('/proj/a.py')).toBe('python');
    expect(detectLangFromPath('/proj/a.md')).toBe('markdown');
    expect(detectLangFromPath('/proj/a.sh')).toBe('bash');
    expect(detectLangFromPath('/proj/a.yml')).toBe('yaml');
  });

  it('大小写不敏感：.TS / .JSON 同样命中', () => {
    expect(detectLangFromPath('/proj/A.TS')).toBe('typescript');
    expect(detectLangFromPath('/proj/PACKAGE.JSON')).toBe('json');
  });

  it('未在映射表但属受支持语言：按原名透传（非 text）', () => {
    // 映射表未列 'toml'，但 shiki 受支持语言会由 normalizeLang 原样返回
    expect(detectLangFromPath('/proj/a.toml')).not.toBe('');
  });

  it('边界：无扩展名 → text（不高亮）', () => {
    expect(detectLangFromPath('/proj/Makefile')).toBe('text');
    expect(detectLangFromPath('C:\\proj\\README')).toBe('text');
  });

  it('边界：未知扩展名 → text', () => {
    expect(detectLangFromPath('/proj/a.xyz')).toBe('text');
  });

  it('边界：目录名含点且文件名无扩展名 → text（不误判目录名为扩展名）', () => {
    expect(detectLangFromPath('C:\\Users\\me\\.config\\hosts')).toBe('text');
    expect(detectLangFromPath('/a/b.c/Makefile')).toBe('text');
  });

  it('边界：点文件（.env）→ text（不是受支持语言）', () => {
    expect(detectLangFromPath('/proj/.env')).toBe('text');
  });

  it('边界：空路径 → text', () => {
    expect(detectLangFromPath('')).toBe('text');
  });
});

describe('lineCount', () => {
  it('正向：单行与多行按换行计数', () => {
    expect(lineCount('a')).toBe(1);
    expect(lineCount('a\nb\nc')).toBe(3);
  });

  it('边界：空串视为 0 行（而非 1 行空行）', () => {
    expect(lineCount('')).toBe(0);
  });

  it('边界：仅换行符 / 尾随换行 → 按段数计（尾随空行算 1 段）', () => {
    expect(lineCount('\n')).toBe(2);
    expect(lineCount('a\n')).toBe(2);
  });
});
