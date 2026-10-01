// packages/shared/src/__tests__/terminal-shell.test.ts
// 终端 shell 档位与字号常量纯函数测试（36 号 B）

import { describe, expect, it } from 'vitest';

import {
  clampFontSize,
  DEFAULT_TERMINAL_FONT_SIZE,
  isShellChoiceApplicable,
  TERMINAL_SHELL_CHOICES,
  type TerminalPlatform,
  terminalShellChoicesForPlatform,
} from '../constants/terminal-shell';

describe('terminalShellChoicesForPlatform', () => {
  it('windows：auto/powershell/cmd/gitbash/wsl', () => {
    expect(terminalShellChoicesForPlatform('windows')).toEqual([
      'auto',
      'powershell',
      'cmd',
      'gitbash',
      'wsl',
    ]);
  });

  it('macos：auto/zsh/bash', () => {
    expect(terminalShellChoicesForPlatform('macos')).toEqual(['auto', 'zsh', 'bash']);
  });

  it('linux：auto/bash/zsh/fish', () => {
    expect(terminalShellChoicesForPlatform('linux')).toEqual(['auto', 'bash', 'zsh', 'fish']);
  });

  it('三平台选项均为全集子集且含 auto', () => {
    const platforms: readonly TerminalPlatform[] = ['windows', 'macos', 'linux'];
    for (const platform of platforms) {
      for (const choice of terminalShellChoicesForPlatform(platform)) {
        expect(TERMINAL_SHELL_CHOICES).toContain(choice);
      }
      expect(terminalShellChoicesForPlatform(platform)).toContain('auto');
    }
  });
});

describe('isShellChoiceApplicable', () => {
  it('跨平台档位判定：wsl 仅 windows、zsh/bash 不在 windows、fish 不在 macos', () => {
    expect(isShellChoiceApplicable('wsl', 'windows')).toBe(true);
    expect(isShellChoiceApplicable('wsl', 'macos')).toBe(false);
    expect(isShellChoiceApplicable('zsh', 'windows')).toBe(false);
    expect(isShellChoiceApplicable('bash', 'windows')).toBe(false);
    expect(isShellChoiceApplicable('bash', 'macos')).toBe(true);
    expect(isShellChoiceApplicable('fish', 'macos')).toBe(false);
    expect(isShellChoiceApplicable('auto', 'linux')).toBe(true);
  });
});

describe('clampFontSize', () => {
  it('非有限数（NaN/Infinity/非数值）→ 默认 13（缺失语义，非钳到最小档）', () => {
    expect(clampFontSize(Number.NaN)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it('档位内原样返回', () => {
    for (const size of [12, 13, 14, 16, 18]) {
      expect(clampFontSize(size)).toBe(size);
    }
  });

  it('档位外归最近档（15 → 14、11 → 12、30 → 18）', () => {
    expect(clampFontSize(15)).toBe(14);
    expect(clampFontSize(11)).toBe(12);
    expect(clampFontSize(30)).toBe(18);
  });
});
