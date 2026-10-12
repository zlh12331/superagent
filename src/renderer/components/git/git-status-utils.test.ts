import { AlertCircle, FileEdit, FilePlus, FileQuestion, FileX } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n/config';
import { getGitStatusMeta } from './git-status-utils';

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

  it('6 状态图标配色（语义基色）', () => {
    expect(getGitStatusMeta('modified').iconClassName).toBe('text-warn');
    expect(getGitStatusMeta('added').iconClassName).toBe('text-success');
    expect(getGitStatusMeta('deleted').iconClassName).toBe('text-error');
    expect(getGitStatusMeta('renamed').iconClassName).toBe('text-accent-2');
    expect(getGitStatusMeta('untracked').iconClassName).toBe('text-muted-foreground');
    expect(getGitStatusMeta('conflicted').iconClassName).toBe('text-error');
  });

  it('6 状态标签配色：小字用 -text 对比度变体（accent-2 无该变体则沿用基色）', () => {
    expect(getGitStatusMeta('modified').labelClassName).toContain('text-warn-text');
    expect(getGitStatusMeta('added').labelClassName).toContain('text-success-text');
    expect(getGitStatusMeta('deleted').labelClassName).toContain('text-error-text');
    expect(getGitStatusMeta('renamed').labelClassName).toBe('text-accent-2');
    expect(getGitStatusMeta('untracked').labelClassName).toBe('text-muted-foreground');
    expect(getGitStatusMeta('conflicted').labelClassName).toBe('text-error-text font-semibold');
  });

  it('边界：图标配色不含字重类（font-* 对 SVG 无意义，是图标/标签分字段的动因）', () => {
    for (const status of [
      'modified',
      'added',
      'deleted',
      'renamed',
      'untracked',
      'conflicted',
    ] as const) {
      expect(getGitStatusMeta(status).iconClassName).not.toContain('font-');
    }
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
