// src/main/infra/codebase/codebase-service.bundle.test.ts
// resolveCodegraphBundle dev 平台包解析单测（P2-37：进程内 memo）
// ──────────────────────────────────────────────────────────────
// 独立文件的原因：memo 用例需要 vi.mock('electron')（app.isPackaged=false）
// 与 vi.mock('node:fs')（readdirSync 间谍），mock 作用域按文件隔离，
// 不影响主测试文件「业务逻辑不 mock」的策略。
// ──────────────────────────────────────────────────────────────

import { readdirSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetCodegraphBundleMemo, resolveCodegraphBundle } from './codebase-service';

vi.mock('electron', () => ({
  app: { isPackaged: false },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
  };
});

describe('resolveCodegraphBundle（dev 平台包解析，P2-37 memo）', () => {
  beforeEach(() => {
    resetCodegraphBundleMemo();
    vi.mocked(readdirSync).mockClear();
  });

  it('dev：同进程二次调用命中 memo（readdirSync 只跑一次，返回同一对象）', () => {
    const first = resolveCodegraphBundle();
    const second = resolveCodegraphBundle();
    expect(vi.mocked(readdirSync)).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    // win32 平台包形态：node.exe + liftoff 入口
    if (process.platform === 'win32') {
      expect(first.command.endsWith('node.exe')).toBe(true);
      expect(first.args[0]).toBe('--liftoff-only');
    }
  });

  it('reset 后重新解析（readdirSync 再次执行）', () => {
    resolveCodegraphBundle();
    resetCodegraphBundleMemo();
    resolveCodegraphBundle();
    expect(vi.mocked(readdirSync)).toHaveBeenCalledTimes(2);
  });
});
