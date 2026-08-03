// src/main/infra/ai/prompt/dynamic-context.test.ts
// dynamic-context 单测：模板变量注入（git 提供者注入 + 失败容忍）

import { describe, expect, it, vi } from 'vitest';

import { type GitSummaryProvider, injectDynamicContext } from './dynamic-context';

/** git 提供者 mock：返回 dirty 状态 */
const dirtyProvider: GitSummaryProvider = async () => ({
  branch: 'feature/agent',
  clean: false,
  changedFiles: 3,
});

/** git 提供者 mock：clean 状态 */
const cleanProvider: GitSummaryProvider = async () => ({
  branch: 'main',
  clean: true,
  changedFiles: 0,
});

/** git 提供者 mock：非 git 仓库（null） */
const nullProvider: GitSummaryProvider = async () => null;

/** git 提供者 mock：抛错（失败容忍） */
const throwingProvider: GitSummaryProvider = async () => {
  throw new Error('git not found');
};

describe('injectDynamicContext', () => {
  it('替换全部模板变量（dirty git 状态）', async () => {
    const template = '目录: {{workingDir}} | 分支: {{gitBranch}} | 状态: {{gitStatus}}';
    const result = await injectDynamicContext(template, {
      workingDir: '/tmp/proj',
      gitSummaryProvider: dirtyProvider,
    });
    // 路径经 resolve 规范化（Windows 下含盘符），用片段断言
    expect(result).toContain('proj');
    expect(result).toContain('分支: feature/agent');
    expect(result).toContain('状态: dirty (3 个文件未提交)');
  });

  it('clean 状态：格式化为 clean', async () => {
    const result = await injectDynamicContext('{{gitStatus}}', {
      workingDir: '/tmp/proj',
      gitSummaryProvider: cleanProvider,
    });
    expect(result).toBe('clean');
  });

  it('非 git 仓库：显示占位符不抛错', async () => {
    const result = await injectDynamicContext('{{gitBranch}}|{{gitStatus}}', {
      workingDir: '/tmp/proj',
      gitSummaryProvider: nullProvider,
    });
    expect(result).toBe('非 git 仓库|未知');
  });

  it('git 查询抛错：失败容忍（占位符）', async () => {
    const result = await injectDynamicContext('{{gitBranch}}', {
      workingDir: '/tmp/proj',
      gitSummaryProvider: throwingProvider,
    });
    expect(result).toBe('非 git 仓库');
  });

  it('未传 gitSummaryProvider：跳过 git 收集', async () => {
    const result = await injectDynamicContext('{{gitBranch}}', { workingDir: '/tmp/proj' });
    expect(result).toBe('非 git 仓库');
  });

  it('os/platform/shell/homeDir 变量替换', async () => {
    const result = await injectDynamicContext('{{os}}|{{platform}}|{{homeDir}}', {
      workingDir: '/tmp/proj',
    });
    expect(result).toContain(process.platform);
    expect(result).toContain('|');
    expect(result).toContain(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '');
  });

  it('重复占位符全部替换（g 标志）', async () => {
    const result = await injectDynamicContext('{{workingDir}} + {{workingDir}}', {
      workingDir: '/a/b',
    });
    // 两处都被替换且一致（Windows 下含盘符前缀）
    const parts = result.split(' + ');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(parts[1]);
    expect(parts[0]).toContain('a');
    expect(parts[0]).toContain('b');
  });

  it('gitSummaryProvider 收到 resolve 后的绝对路径', async () => {
    const provider = vi.fn(async () => null);
    await injectDynamicContext('x', {
      workingDir: 'relative/path',
      gitSummaryProvider: provider,
    });
    expect(provider).toHaveBeenCalledWith(expect.stringContaining('relative'));
  });
});
