// src/renderer/lib/utils.test.ts
// lib/utils 纯函数单测（basename / fileExtension 边界）
// ──────────────────────────────────────────────────────────────
// basename 由渲染层 4 份重复实现收敛而来，锁定统一后的语义：
// - 两种分隔符（\ 与 /）与混合分隔符均取最后一段
// - 尾部分隔符先剥掉（此前一份实现返回空串、另一份回退整条路径）
// - 纯分隔符 / 空串原样返回
//
// fileExtension 由 file-viewer-utils（语言检测）与 file-icon（图标配色）
// 两份相同实现收敛而来，两处口径必须一致才不会出现「高亮按 ts、图标按 text」。
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { basename, fileExtension } from './utils';

describe('basename', () => {
  it('Windows 反斜杠路径：取最后一段', () => {
    expect(basename('C:\\proj\\src\\a.ts')).toBe('a.ts');
  });

  it('POSIX 正斜杠路径：取最后一段', () => {
    expect(basename('/proj/src/a.ts')).toBe('a.ts');
  });

  it('混合分隔符：仍取最后一段', () => {
    expect(basename('C:\\proj/src\\a.ts')).toBe('a.ts');
  });

  it('尾部分隔符：先剥掉再取段（不返回空串）', () => {
    expect(basename('/proj/src/')).toBe('src');
    expect(basename('C:\\proj\\src\\')).toBe('src');
    expect(basename('a/b//')).toBe('b');
  });

  it('无分隔符：原样返回', () => {
    expect(basename('a.ts')).toBe('a.ts');
  });

  it('点文件：整体作为一段返回', () => {
    expect(basename('/proj/.env')).toBe('.env');
    expect(basename('.env')).toBe('.env');
  });

  it('纯分隔符：原样返回（对齐 POSIX basename 语义）', () => {
    expect(basename('/')).toBe('/');
    expect(basename('\\')).toBe('\\');
  });

  it('空串：原样返回', () => {
    expect(basename('')).toBe('');
  });

  it('目录名含点：不误切（点属于目录名而非文件名）', () => {
    expect(basename('C:\\Users\\me\\.config\\hosts')).toBe('hosts');
    expect(basename('/a/b.c/Makefile')).toBe('Makefile');
  });
});

describe('fileExtension', () => {
  it('正向：取最后一个点之后（不含点）', () => {
    expect(fileExtension('a.ts')).toBe('ts');
    expect(fileExtension('/proj/src/index.tsx')).toBe('tsx');
  });

  it('正向：大小写不敏感（统一转小写）', () => {
    expect(fileExtension('A.TS')).toBe('ts');
    expect(fileExtension('PACKAGE.JSON')).toBe('json');
  });

  it('边界：多点文件名取最后一段（a.test.ts → ts）', () => {
    expect(fileExtension('a.test.ts')).toBe('ts');
    expect(fileExtension('archive.tar.gz')).toBe('gz');
  });

  it('边界：无点返回空串', () => {
    expect(fileExtension('Makefile')).toBe('');
    expect(fileExtension('/proj/src/Makefile')).toBe('');
  });

  it('边界：点文件（.env）按「点在位置 0」切分 → env', () => {
    // 与两处原实现的 lastIndexOf('.') 口径逐位对齐（不是「无扩展名」）
    expect(fileExtension('.env')).toBe('env');
  });

  it('边界：尾点 → 点后为空 → 空串', () => {
    expect(fileExtension('a.')).toBe('');
  });

  it('边界：空串 → 空串', () => {
    expect(fileExtension('')).toBe('');
  });

  it('异常：不剥目录，只按最后一个点切分（与两处原实现口径一致）', () => {
    // 目录名含点时，返回的片段会横跨「目录 + 文件」两部分（不是空串）。
    // 后果可控：该片段必然不是受支持语言/图标扩展名 → 下游回落默认值。
    expect(fileExtension('C:\\Users\\me\\.config\\hosts')).toBe('config\\hosts');
    expect(fileExtension('/a/b.c/Makefile')).toBe('c/makefile');
  });
});
