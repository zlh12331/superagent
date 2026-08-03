// scripts/changelog/lib/parse.test.ts
// parse 纯函数单测：conventional commit 解析与分组
import { describe, expect, it } from 'vitest';

import { entryText, groupOf, parseCommit, shouldInclude } from './parse';

/** 解析并断言非 null（测试辅助，替代非空断言） */
function parsed(message: string): ReturnType<typeof parseCommit> & NonNullable<unknown> {
  const result = parseCommit('a', message);
  if (result === null) {
    throw new Error(`解析失败：${message}`);
  }
  return result;
}

describe('parseCommit', () => {
  it('解析基本格式 type: subject', () => {
    const parsed = parseCommit('abc123', 'feat: 新增自动更新链路');
    expect(parsed).toEqual({
      hash: 'abc123',
      type: 'feat',
      scope: null,
      breaking: false,
      description: '新增自动更新链路',
      subject: 'feat: 新增自动更新链路',
    });
  });

  it('解析 scope：type(scope): subject', () => {
    const parsed = parseCommit('abc123', 'fix(update): 修复更新检查失败');
    expect(parsed?.scope).toBe('update');
    expect(parsed?.description).toBe('修复更新检查失败');
  });

  it('解析破坏性变更：type!: subject', () => {
    const parsed = parseCommit('abc123', 'feat!: 重写 IPC 通道命名');
    expect(parsed?.breaking).toBe(true);
  });

  it('解析破坏性变更：body 中 BREAKING CHANGE', () => {
    const parsed = parseCommit(
      'abc123',
      'feat: 重写 IPC 通道命名\n\nBREAKING CHANGE: 通道名全部变更',
    );
    expect(parsed?.breaking).toBe(true);
  });

  it('无法解析的提交返回 null', () => {
    expect(parseCommit('abc123', '随便写的提交')).toBeNull();
    expect(parseCommit('abc123', '')).toBeNull();
  });
});

describe('shouldInclude / groupOf', () => {
  it('feat/fix/perf 进入 CHANGELOG', () => {
    expect(shouldInclude(parsed('feat: x'))).toBe(true);
    expect(shouldInclude(parsed('fix: x'))).toBe(true);
    expect(shouldInclude(parsed('perf: x'))).toBe(true);
  });

  it('开发内部类型排除（docs/chore/test/refactor 等）', () => {
    for (const type of ['docs', 'chore', 'style', 'test', 'refactor', 'build', 'ci']) {
      expect(shouldInclude(parsed(`${type}: x`))).toBe(false);
    }
  });

  it('分组：feat→新增 / fix→修复 / perf→性能', () => {
    expect(groupOf(parsed('feat: x'))).toBe('feat');
    expect(groupOf(parsed('fix: x'))).toBe('fix');
    expect(groupOf(parsed('perf: x'))).toBe('perf');
  });

  it('破坏性变更优先分组（无论 type）', () => {
    expect(groupOf(parsed('fix!: x'))).toBe('breaking');
    expect(groupOf(parsed('feat: x\n\nBREAKING CHANGE: y'))).toBe('breaking');
  });

  it('排除类型 groupOf 返回 null', () => {
    expect(groupOf(parsed('docs: x'))).toBeNull();
  });
});

describe('entryText', () => {
  it('无 scope：直接描述', () => {
    expect(entryText(parsed('fix: 修复缓存问题'))).toBe('修复缓存问题');
  });

  it('有 scope：scope 前缀保留', () => {
    expect(entryText(parsed('feat(update): 接入自动更新'))).toBe('`update`：接入自动更新');
  });
});
