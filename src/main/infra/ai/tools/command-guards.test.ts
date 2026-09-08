// src/main/infra/ai/tools/command-guards.test.ts
// 权限决策确定性原语单测：白名单模式 / 前缀匹配 / 复合命令 / 路径越界 / 命令提取

import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  commandTargetsOutsideBoundary,
  extractCommandFromInput,
  isCompositeCommand,
  isUniversalWhitelistPattern,
  matchesWhitelistPattern,
} from './command-guards';

/** Windows 下 junction 无需管理员权限；POSIX 用 dir 链接 */
const SYMLINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

describe('isUniversalWhitelistPattern（等同放行全部调用的模式：fail closed）', () => {
  it('空串 / 纯通配符 / 仅空白均视为通用模式', () => {
    for (const pattern of ['', ' ', '*', '**', '.*', '?', ' * * ', '***']) {
      expect(isUniversalWhitelistPattern(pattern), `pattern=${JSON.stringify(pattern)}`).toBe(true);
    }
  });
  it('具体命令不是通用模式', () => {
    expect(isUniversalWhitelistPattern('npm test')).toBe(false);
    expect(isUniversalWhitelistPattern('git status')).toBe(false);
  });
});

describe('matchesWhitelistPattern（token 级前缀匹配）', () => {
  it('相等命中', () => {
    expect(matchesWhitelistPattern('npm test', 'npm test')).toBe(true);
  });
  it('前缀 + 空白边界命中', () => {
    expect(matchesWhitelistPattern('npm test -- --watch', 'npm test')).toBe(true);
    expect(matchesWhitelistPattern('  npm test  --watch', 'npm test')).toBe(true);
  });
  it('前缀但无词边界不命中（npm testcase）', () => {
    expect(matchesWhitelistPattern('npm testcase', 'npm test')).toBe(false);
  });
  it('任意位置 includes 不命中（echo npm test）', () => {
    expect(matchesWhitelistPattern('echo npm test', 'npm test')).toBe(false);
  });
  it('大小写敏感', () => {
    expect(matchesWhitelistPattern('NPM TEST', 'npm test')).toBe(false);
  });
});

describe('isCompositeCommand（复合命令识别）', () => {
  it.each(['npm test; ls', 'a | b', 'a & b', 'echo `whoami`', 'echo $(pwd)', 'a\nb'])(
    '识别复合特征：%s',
    (cmd) => {
      expect(isCompositeCommand(cmd)).toBe(true);
    },
  );
  it('单一简单命令不识别', () => {
    expect(isCompositeCommand('npm test')).toBe(false);
    expect(isCompositeCommand('git push -u origin main')).toBe(false);
  });

  // 2026-09-08 安全修复：重定向此前不被视为复合命令，导致
  // `npm test > ~/.ssh/authorized_keys` 命中白名单前缀后在边界外写文件
  it.each(['npm test > out.txt', 'npm test >> out.txt', 'cat < secret.txt'])(
    '重定向识别为复合：%s',
    (cmd) => {
      expect(isCompositeCommand(cmd)).toBe(true);
    },
  );
});

describe('commandTargetsOutsideBoundary（路径越界识别）', () => {
  const boundary = '/repo';

  it('绝对路径指向边界外 → 越界', () => {
    expect(commandTargetsOutsideBoundary('cat /etc/passwd', boundary)).toBe(true);
  });

  it('~ 展开到边界外 → 越界', () => {
    expect(commandTargetsOutsideBoundary('cat ~/notes.txt', boundary)).toBe(true);
  });

  it('../ 链逃逸边界 → 越界', () => {
    expect(commandTargetsOutsideBoundary('cat ../secrets.txt', boundary)).toBe(true);
    expect(commandTargetsOutsideBoundary('rm -rf ../../', boundary)).toBe(true);
  });

  it('边界内命令 → 不越界', () => {
    expect(commandTargetsOutsideBoundary('ls', boundary)).toBe(false);
    expect(commandTargetsOutsideBoundary('cat src/main.ts', boundary)).toBe(false);
    expect(commandTargetsOutsideBoundary('npm run test', boundary)).toBe(false);
  });

  // 2026-09-08 安全修复：变量展开此前被 resolvePathToken 当普通相对段
  // 拼到边界目录下，于是 `cat $HOME/.ssh/id_rsa` 被判为界内只读命令而免审批
  it.each([
    'cat $HOME/.ssh/id_rsa',
    'cat ${HOME}/.ssh/id_rsa',
    'type %USERPROFILE%\\.aws\\credentials',
    'ls $HOME',
  ])('变量展开路径 → 越界（fail closed）：%s', (cmd) => {
    expect(commandTargetsOutsideBoundary(cmd, boundary)).toBe(true);
  });

  it('正则/普通参数含 $ 但不含路径分隔符 → 不误判', () => {
    expect(commandTargetsOutsideBoundary("grep -E '^[a-z]+$' src/main.ts", boundary)).toBe(false);
    expect(commandTargetsOutsideBoundary('echo $1', boundary)).toBe(false);
  });

  it('URL token 不误判为路径', () => {
    expect(commandTargetsOutsideBoundary('curl https://example.com/a/b', boundary)).toBe(false);
  });

  // 2026-09-06 安全审计修复：symlink 逃逸（此前相对路径 token 不参与边界判定）
  it('工作区内 symlink 指向边界外（相对路径 token）→ 越界', () => {
    const outside = mkdtempSync(join(tmpdir(), 'cmd-guard-outside-'));
    const workspace = mkdtempSync(join(tmpdir(), 'cmd-guard-ws-'));
    try {
      symlinkSync(outside, join(workspace, 'link'), SYMLINK_TYPE);
      // 字符串级 relative 判定为界内；realpath 后落点在界外
      expect(commandTargetsOutsideBoundary('cat link/secret.txt', workspace)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('工作区内 symlink 指向边界外（绝对路径 token）→ 越界', () => {
    const outside = mkdtempSync(join(tmpdir(), 'cmd-guard-outside2-'));
    const workspace = mkdtempSync(join(tmpdir(), 'cmd-guard-ws2-'));
    try {
      symlinkSync(outside, join(workspace, 'link'), SYMLINK_TYPE);
      expect(
        commandTargetsOutsideBoundary(`cat ${join(workspace, 'link', 'secret.txt')}`, workspace),
      ).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('工作区内 symlink 指向边界内 → 不越界（不误伤 pnpm 结构）', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cmd-guard-ws3-'));
    try {
      symlinkSync(workspace, join(workspace, 'self'), SYMLINK_TYPE);
      expect(commandTargetsOutsideBoundary('cat self/src/a.ts', workspace)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('extractCommandFromInput（工具入参提取命令）', () => {
  it('run_command 风格：提取 command 字段', () => {
    expect(extractCommandFromInput({ command: 'npm test', cwd: '/x' })).toBe('npm test');
  });
  it('terminal 风格：无 command 字段返回 undefined', () => {
    expect(extractCommandFromInput({ args: ['ls'] })).toBeUndefined();
  });
  it('非对象 / null / 空字符串均返回 undefined', () => {
    expect(extractCommandFromInput('cmd')).toBeUndefined();
    expect(extractCommandFromInput(null)).toBeUndefined();
    expect(extractCommandFromInput({ command: '   ' })).toBeUndefined();
  });
});
