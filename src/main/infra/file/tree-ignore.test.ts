// src/main/infra/file/tree-ignore.test.ts
// 文件树忽略规则单测：名称匹配（精确/通配）+ 用户配置归一化

import { describe, expect, it } from 'vitest';
import { matchIgnorePattern, normalizeTreeIgnorePatterns } from './tree-ignore';

describe('matchIgnorePattern', () => {
  it('精确匹配：basename 相等', () => {
    expect(matchIgnorePattern('node_modules', ['node_modules', 'dist'])).toBe(true);
    expect(matchIgnorePattern('dist', ['node_modules', 'dist'])).toBe(true);
    expect(matchIgnorePattern('src', ['node_modules', 'dist'])).toBe(false);
  });

  it('* 通配：跨任意非分隔符字符序列', () => {
    expect(matchIgnorePattern('app.log', ['*.log'])).toBe(true);
    expect(matchIgnorePattern('error.log.1', ['*.log*'])).toBe(true);
    expect(matchIgnorePattern('cache', ['c*'])).toBe(true);
    // 不跨路径分隔符（名称级匹配本身无分隔符，防御正则语义）
    expect(matchIgnorePattern('a/b', ['*'])).toBe(false);
  });

  it('? 通配：恰好一个字符', () => {
    expect(matchIgnorePattern('ab', ['a?'])).toBe(true);
    expect(matchIgnorePattern('abc', ['a?'])).toBe(false);
  });

  it('空模式列表 / 空白模式：不忽略', () => {
    expect(matchIgnorePattern('anything', [])).toBe(false);
    expect(matchIgnorePattern('anything', ['', '  '])).toBe(false);
  });

  it('正则元字符按字面量处理（防注入）', () => {
    expect(matchIgnorePattern('a.b', ['a.b'])).toBe(true);
    expect(matchIgnorePattern('axb', ['a.b'])).toBe(false);
    expect(matchIgnorePattern('(test)', ['(test)'])).toBe(true);
  });
});

describe('normalizeTreeIgnorePatterns', () => {
  it('字符串数组：trim + 去空 + 保序', () => {
    expect(normalizeTreeIgnorePatterns([' dist ', '*.log', '', 'build'])).toEqual([
      'dist',
      '*.log',
      'build',
    ]);
  });

  it('非数组 / 含非字符串元素：过滤', () => {
    expect(normalizeTreeIgnorePatterns(undefined)).toEqual([]);
    expect(normalizeTreeIgnorePatterns('node_modules')).toEqual([]);
    expect(normalizeTreeIgnorePatterns(['ok', 42, null])).toEqual(['ok']);
  });

  it('超长模式截断丢弃（>64 字符），数量上限 32 条', () => {
    const long = 'x'.repeat(65);
    expect(normalizeTreeIgnorePatterns([long, 'ok'])).toEqual(['ok']);
    const many = Array.from({ length: 40 }, (_, i) => `p${i}`);
    expect(normalizeTreeIgnorePatterns(many)).toHaveLength(32);
  });
});
