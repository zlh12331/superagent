// src/renderer/lib/working-dir.test.ts
// resolveWorkingDir 纯函数测试：knownDir 优先 / 索引回退 / 未知返回 null

import { describe, expect, it } from 'vitest';

import { resolveWorkingDir } from './working-dir';

const index = new Map([
  ['s1', '/proj/a'],
  ['s2', ''],
]);

describe('resolveWorkingDir', () => {
  it('knownDir 非空 → 优先于索引', () => {
    expect(
      resolveWorkingDir({ knownDir: '/authoritative', dirBySession: index, sessionId: 's1' }),
    ).toBe('/authoritative');
  });

  it('knownDir 为空串 → 回退索引', () => {
    expect(resolveWorkingDir({ knownDir: '', dirBySession: index, sessionId: 's1' })).toBe(
      '/proj/a',
    );
  });

  it('knownDir 为 null/undefined → 回退索引', () => {
    expect(resolveWorkingDir({ knownDir: null, dirBySession: index, sessionId: 's1' })).toBe(
      '/proj/a',
    );
    expect(resolveWorkingDir({ knownDir: undefined, dirBySession: index, sessionId: 's1' })).toBe(
      '/proj/a',
    );
  });

  it('sessionId 为 null/空 → null（无激活会话）', () => {
    expect(resolveWorkingDir({ knownDir: null, dirBySession: index, sessionId: null })).toBeNull();
    expect(resolveWorkingDir({ knownDir: null, dirBySession: index, sessionId: '' })).toBeNull();
    expect(
      resolveWorkingDir({ knownDir: null, dirBySession: index, sessionId: undefined }),
    ).toBeNull();
  });

  it('索引缺失或值为空串 → null', () => {
    expect(resolveWorkingDir({ knownDir: null, dirBySession: index, sessionId: 's9' })).toBeNull();
    expect(resolveWorkingDir({ knownDir: null, dirBySession: index, sessionId: 's2' })).toBeNull();
  });
});
