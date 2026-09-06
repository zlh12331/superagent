// src/main/infra/ai/tools/command-guards.test.ts
// 权限决策确定性原语单测：白名单模式 / 前缀匹配 / 复合命令 / 路径越界 / 命令提取

import { describe, expect, it } from 'vitest';
import {
  commandTargetsOutsideBoundary,
  extractCommandFromInput,
  isCompositeCommand,
  isUniversalWhitelistPattern,
  matchesWhitelistPattern,
} from './command-guards';

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
