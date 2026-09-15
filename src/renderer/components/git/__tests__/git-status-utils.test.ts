// src/renderer/components/git/__tests__/git-status-utils.test.ts
// git-status-utils 表驱动单元测试
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. getGitStatusMeta：6 状态全量映射（icon/className）
// 2. i18n 键契约：check:i18n 对动态模板前缀域（git. 等）豁免静态检查，
//    此处运行时兜底——i18next 缺键时返回键本身，「翻译 ≠ 键」即键存在
// ──────────────────────────────────────────────────────────────

import { AlertCircle, FileEdit, FilePlus, FileQuestion, FileX } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n/config';
import { getGitStatusMeta } from '../git-status-utils';

const t = i18n.t.bind(i18n);

describe('git-status-utils', () => {
  it('6 状态图标映射', () => {
    expect(getGitStatusMeta('modified').icon).toBe(FileEdit);
    expect(getGitStatusMeta('added').icon).toBe(FilePlus);
    expect(getGitStatusMeta('deleted').icon).toBe(FileX);
    expect(getGitStatusMeta('renamed').icon).toBe(FileEdit);
    expect(getGitStatusMeta('untracked').icon).toBe(FileQuestion);
    expect(getGitStatusMeta('conflicted').icon).toBe(AlertCircle);
  });

  it('6 状态颜色语义类', () => {
    expect(getGitStatusMeta('modified').className).toContain('text-warn');
    expect(getGitStatusMeta('added').className).toContain('text-success');
    expect(getGitStatusMeta('deleted').className).toContain('text-error');
    expect(getGitStatusMeta('renamed').className).toContain('text-accent-2');
    expect(getGitStatusMeta('untracked').className).toContain('text-muted-foreground');
    expect(getGitStatusMeta('conflicted').className).toContain('text-error');
  });

  it('i18n 键契约：6 状态均有 git.<status> 键', () => {
    const statuses = [
      'modified',
      'added',
      'deleted',
      'renamed',
      'untracked',
      'conflicted',
    ] as const;
    for (const status of statuses) {
      const key = `git.${status}`;
      expect(t(key), `${key} 缺失`).not.toBe(key);
    }
  });
});
