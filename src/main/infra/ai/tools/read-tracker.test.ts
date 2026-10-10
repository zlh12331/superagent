import { beforeEach, describe, expect, it } from 'vitest';
import { readTracker } from './read-tracker';

describe('readTracker（编辑前必须先读）', () => {
  beforeEach(() => {
    readTracker.clearSession('session-a');
    readTracker.clearSession('session-b');
  });

  it('记录后 has 命中；未记录不命中', () => {
    expect(readTracker.has('session-a', '/repo/a.ts')).toBe(false);
    readTracker.record('session-a', '/repo/a.ts');
    expect(readTracker.has('session-a', '/repo/a.ts')).toBe(true);
  });

  it('会话间隔离：A 的读取不影响 B', () => {
    readTracker.record('session-a', '/repo/a.ts');
    expect(readTracker.has('session-b', '/repo/a.ts')).toBe(false);
  });

  it('同会话多文件各自独立', () => {
    readTracker.record('session-a', '/repo/a.ts');
    readTracker.record('session-a', '/repo/b.ts');
    expect(readTracker.has('session-a', '/repo/b.ts')).toBe(true);
    expect(readTracker.has('session-a', '/repo/c.ts')).toBe(false);
  });

  it('clearSession 清除后不再命中（回合结束清理）', () => {
    readTracker.record('session-a', '/repo/a.ts');
    readTracker.clearSession('session-a');
    expect(readTracker.has('session-a', '/repo/a.ts')).toBe(false);
    readTracker.record('session-b', '/repo/b.ts');
    expect(readTracker.has('session-b', '/repo/b.ts')).toBe(true);
  });
});
