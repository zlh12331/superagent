// src/renderer/lib/utils.test.ts
// lib/utils 纯函数单测（basename 边界）
// ──────────────────────────────────────────────────────────────
// basename 由渲染层 4 份重复实现收敛而来，锁定统一后的语义：
// - 两种分隔符（\ 与 /）与混合分隔符均取最后一段
// - 尾部分隔符先剥掉（此前一份实现返回空串、另一份回退整条路径）
// - 纯分隔符 / 空串原样返回
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { basename } from './utils';

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
