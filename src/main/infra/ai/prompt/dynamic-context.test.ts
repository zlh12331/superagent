// src/main/infra/ai/prompt/dynamic-context.test.ts
// dynamic-context 单测：模板变量注入（git 提供者注入 + 失败容忍）

import { homedir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import {
  type GitSummaryProvider,
  gitSummaryProviderFrom,
  injectDynamicContext,
} from './dynamic-context';

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

  it('替换值含 `$&`：不得被解释为"整段匹配"模式（workingDir）', async () => {
    const result = await injectDynamicContext('{{workingDir}}', {
      workingDir: '/tmp/x$&y',
    });
    expect(result).not.toContain('{{workingDir}}');
    expect(result).toContain('$&y');
  });

  it('替换值含 `$&`：不得被解释为"整段匹配"模式（gitBranch）', async () => {
    const provider: GitSummaryProvider = async () => ({
      branch: '$&',
      clean: true,
      changedFiles: 0,
    });
    const result = await injectDynamicContext('分支: {{gitBranch}}', {
      workingDir: '/tmp/proj',
      gitSummaryProvider: provider,
    });
    expect(result).toBe('分支: $&');
  });

  it('单次遍历：仓库可控值里的 `{{homeDir}}` 字面量不得被二次替换', async () => {
    const provider: GitSummaryProvider = async () => ({
      branch: '{{homeDir}}',
      clean: true,
      changedFiles: 0,
    });
    const result = await injectDynamicContext('{{gitBranch}} | {{homeDir}}', {
      workingDir: '/tmp/proj',
      gitSummaryProvider: provider,
    });
    const home = homedir();
    // 只有模板自身的 homeDir 占位符被替换（出现一次），注入进来的字面量保持原样
    expect(result.match(new RegExp(home.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&'), 'g'))).toHaveLength(
      1,
    );
    expect(result.startsWith('{{homeDir}} | ')).toBe(true);
  });

  it('未登记的占位符保持原样', async () => {
    const result = await injectDynamicContext('{{unknownVar}}-{{os}}', {
      workingDir: '/tmp/proj',
    });
    expect(result.startsWith('{{unknownVar}}-')).toBe(true);
  });
});

describe('dynamic-context 批次13 缺口补全', () => {
  // PowerShell 回退仅 win32 语义：非 Windows 返回原生 shell，断言 powershell.exe 无意义
  it.skipIf(process.platform !== 'win32')(
    'COMSPEC 缺失：shell 占位符回退 powershell.exe（win32）',
    async () => {
      const original = process.env['COMSPEC'];
      delete process.env['COMSPEC'];
      try {
        const result = await injectDynamicContext('{{shell}}', { workingDir: '/tmp' });
        expect(result).toContain('powershell.exe');
      } finally {
        if (original !== undefined) {
          process.env['COMSPEC'] = original;
        }
      }
    },
  );
});

describe('gitSummaryProviderFrom（GitService → GitSummary 适配）', () => {
  it('映射 branch / clean / files.length 到 GitSummary', async () => {
    const provider = gitSummaryProviderFrom(async () => ({
      branch: 'feature/agent',
      clean: false,
      files: [{ path: 'a' }, { path: 'b' }, { path: 'c' }],
    }));
    expect(await provider('/tmp/proj')).toEqual({
      branch: 'feature/agent',
      clean: false,
      changedFiles: 3,
    });
  });

  it('clean 仓库：changedFiles 为 0', async () => {
    const provider = gitSummaryProviderFrom(async () => ({
      branch: 'main',
      clean: true,
      files: [],
    }));
    expect(await provider('/tmp/proj')).toEqual({ branch: 'main', clean: true, changedFiles: 0 });
  });

  it('workingDir 原样透传给底层查询', async () => {
    const getStatus = vi.fn(async () => ({ branch: 'main', clean: true, files: [] }));
    await gitSummaryProviderFrom(getStatus)('/tmp/proj');
    expect(getStatus).toHaveBeenCalledWith('/tmp/proj');
  });

  it('查询抛错：向上抛出（由 injectDynamicContext 兜底为占位符）', async () => {
    const provider = gitSummaryProviderFrom(async () => {
      throw new Error('not a git repository');
    });
    await expect(provider('/tmp/proj')).rejects.toThrow('not a git repository');
  });

  it('接入 injectDynamicContext：模板变量替换为真实 git 状态', async () => {
    const provider = gitSummaryProviderFrom(async () => ({
      branch: 'main',
      clean: false,
      files: [{ path: 'a' }],
    }));
    const result = await injectDynamicContext('{{gitBranch}}|{{gitStatus}}', {
      workingDir: '/tmp/proj',
      gitSummaryProvider: provider,
    });
    expect(result).toBe('main|dirty (1 个文件未提交)');
  });
});
