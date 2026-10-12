import { describe, expect, it } from 'vitest';

import {
  buildFileSearchPattern,
  escapeGlob,
  extractDir,
  toCaseInsensitiveGlob,
} from './file-search';

describe('escapeGlob', () => {
  it('正向：普通字符原样返回（无转义符污染）', () => {
    expect(escapeGlob('main.ts')).toBe('main.ts');
    expect(escapeGlob('目录/文件')).toBe('目录/文件');
  });

  it('正向：glob 元字符逐一转义', () => {
    expect(escapeGlob('*')).toBe('\\*');
    expect(escapeGlob('?')).toBe('\\?');
    expect(escapeGlob('[ab]')).toBe('\\[ab\\]');
    expect(escapeGlob('{a,b}')).toBe('\\{a,b\\}');
    expect(escapeGlob('(x)')).toBe('\\(x\\)');
    expect(escapeGlob('!neg')).toBe('\\!neg');
  });

  it('边界：混合串只转义元字符，字母与点不动', () => {
    expect(escapeGlob('a*b.ts')).toBe('a\\*b.ts');
    expect(escapeGlob('**')).toBe('\\*\\*');
  });

  it('边界：空串返回空串', () => {
    expect(escapeGlob('')).toBe('');
  });

  it('异常：反斜杠不在转义集合内（输入已含转义符时不双重转义）', () => {
    expect(escapeGlob('\\*')).toBe('\\\\*');
    expect(escapeGlob('\\')).toBe('\\');
  });
});

describe('toCaseInsensitiveGlob', () => {
  it('正向：每个字母展开为小写+大写字符类', () => {
    expect(toCaseInsensitiveGlob('a')).toBe('[aA]');
    expect(toCaseInsensitiveGlob('Ab')).toBe('[aA][bB]');
  });

  it('边界：非字母（数字/点/短横线）原样保留，其两侧字母各自展开', () => {
    expect(toCaseInsensitiveGlob('a1.ts-x')).toBe('[aA]1.[tT][sS]-[xX]');
  });

  it('边界：空串返回空串', () => {
    expect(toCaseInsensitiveGlob('')).toBe('');
  });

  it('异常：反斜杠非字母，不被包成字符类（保证 escapeGlob 的转义语义不被破坏）', () => {
    expect(toCaseInsensitiveGlob('\\')).toBe('\\');
    expect(toCaseInsensitiveGlob('\\*')).toBe('\\*');
  });
});

describe('buildFileSearchPattern', () => {
  it('正向：递归通配 + 展开后的关键词 + 尾通配', () => {
    expect(buildFileSearchPattern('app')).toBe('**/*[aA][pP][pP]*');
  });

  it('正向：数字与点不展开', () => {
    expect(buildFileSearchPattern('a1')).toBe('**/*[aA]1*');
  });

  it('边界：单字符查询', () => {
    expect(buildFileSearchPattern('z')).toBe('**/*[zZ]*');
  });

  it('异常关键点：先转义再展开（`*` 被转义为字面量，不得退化为通配）', () => {
    const pattern = buildFileSearchPattern('*');
    expect(pattern).toBe('**/*\\**');
    expect(pattern).not.toContain('[\\]');
  });

  it('异常：带 glob 元字符的查询仍保持字面量语义', () => {
    expect(buildFileSearchPattern('[a]')).toBe('**/*\\[[aA]\\]*');
  });
});

describe('extractDir', () => {
  it('正向：POSIX 路径取目录部分', () => {
    expect(extractDir('/proj/src/App.tsx')).toBe('/proj/src');
  });

  it('正向：Windows 反斜杠统一转换为正斜杠', () => {
    expect(extractDir('C:\\proj\\src\\App.tsx')).toBe('C:/proj/src');
  });

  it('边界：无分隔符（相对文件名）返回空串', () => {
    expect(extractDir('App.tsx')).toBe('');
  });

  it('边界：绝对路径根级文件返回空串', () => {
    expect(extractDir('/App.tsx')).toBe('');
  });

  it('边界：空路径返回空串', () => {
    expect(extractDir('')).toBe('');
  });

  it('边界：尾部分隔符（目录形式的路径）截到最后一段之前', () => {
    expect(extractDir('/proj/src/')).toBe('/proj/src');
  });
});
