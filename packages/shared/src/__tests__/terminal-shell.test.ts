// terminal-shell.test.ts：终端 shell 档位表 / 跨平台适用性 / 字号归一三组纯函数契约
// 边界：只覆盖 shared 常量层；主进程 spawn 回落见 src/main/infra/terminal/terminal-service.test.ts，
// 设置页 UI 见 src/renderer/components/settings/sections/terminal-section.test.tsx
// 契约来源：docs/implementation/36-settings-gaps-spec.md §1B 终端设置域

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
  // 按序精确断言（不用 toContain）：数组顺序即设置页 SegControl 的下拉顺序，同时是主进程
  // 适用性判定的同一份真源——增删档位或改序都必须在这里显式确认
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

  // 不变式：平台表必须是 TERMINAL_SHELL_CHOICES（设置值域的来源）的子集，且三平台都保留
  // auto——auto 即「跟随平台默认」，与档位不适用时的回落落点是同一个
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
  // false 不是报错：调用方据此回落平台默认（fail-open），负例锁住的就是这些回落触发点
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
  // 缺失/彻底损坏（NaN/Infinity）归默认而非钳到最小档：若省掉前置拦截，NaN 的比较全为 false，
  // 扫描会静默停在数组首项（12），把损坏值伪装成用户的显式选择
  it('非有限数（NaN/Infinity/非数值）→ 默认 13（缺失语义，非钳到最小档）', () => {
    expect(clampFontSize(Number.NaN)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it('档位内原样返回', () => {
    for (const size of [12, 13, 14, 16, 18]) {
      expect(clampFontSize(size)).toBe(size);
    }
  });

  // 15 是 14/16 的中点平局，锁定平局取低档（升序扫描 + 严格小于）；11/30 锁定越界取端点
  it('档位外归最近档（15 → 14、11 → 12、30 → 18）', () => {
    expect(clampFontSize(15)).toBe(14);
    expect(clampFontSize(11)).toBe(12);
    expect(clampFontSize(30)).toBe(18);
  });
});
