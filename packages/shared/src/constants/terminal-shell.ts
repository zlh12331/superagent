// packages/shared/src/constants/terminal-shell.ts
// 终端默认 shell 档位与字号常量（36 号 B；单一真源，主进程/渲染层共用）
// ──────────────────────────────────────────────────────────────
// shell 语义：settings.terminal.shell 是「交互式终端的默认 shell 选择」，
// 主进程 TerminalService 在 PTY spawn 时刻即时读取并解析（渲染层不传 shell——
// terminal:create 的 P0 收口保持：契约无 shell 字段，配置由主进程消费）。
// 字号语义：xterm.js fontSize（px），档位制（对齐 35 号 clampZoom 先例）。
// ──────────────────────────────────────────────────────────────

/** 合法 shell 档位（全集；平台适用性由 terminalShellChoicesForPlatform 收敛） */
export const TERMINAL_SHELL_CHOICES = [
  'auto',
  'powershell',
  'cmd',
  'gitbash',
  'wsl',
  'bash',
  'zsh',
  'fish',
] as const;

/** shell 档位类型（settings.terminal.shell 值域） */
export type TerminalShellChoice = (typeof TERMINAL_SHELL_CHOICES)[number];

/**
 * 平台描述符（主进程 process.platform 与渲染层 navigator.platform 的公共归一形态）
 *
 * shared 不引 Node 类型：两端各自把原生平台值归一成本三元组（主进程三行映射，
 * 渲染层 navigator.platform 前缀判断），纯函数只消费归一结果。
 */
export type TerminalPlatform = 'windows' | 'macos' | 'linux';

/**
 * 平台可用的 shell 选项表（UI 下拉选项与主进程适用性判定共用同一真源）
 *
 * - windows：PowerShell（默认）/ CMD / Git Bash / WSL
 * - macos：zsh（Catalina 起 macOS 默认）/ bash
 * - linux：bash / zsh / fish（默认发行版 shell 差异大，auto 交还 $SHELL）
 */
export function terminalShellChoicesForPlatform(
  platform: TerminalPlatform,
): readonly TerminalShellChoice[] {
  switch (platform) {
    case 'windows':
      return ['auto', 'powershell', 'cmd', 'gitbash', 'wsl'];
    case 'macos':
      return ['auto', 'zsh', 'bash'];
    case 'linux':
      return ['auto', 'bash', 'zsh', 'fish'];
  }
}

/** 档位是否在平台可用（主进程解析前的适用性收窄：不适用 → 回落平台默认） */
export function isShellChoiceApplicable(
  choice: TerminalShellChoice,
  platform: TerminalPlatform,
): boolean {
  return terminalShellChoicesForPlatform(platform).includes(choice);
}

/** 合法字号档位（px，升序；SegControl 选项与 clampFontSize 共用） */
export const TERMINAL_FONT_SIZES: readonly number[] = [12, 13, 14, 16, 18];

/**
 * 默认终端字号（13 = 此前 xterm 硬编码值——默认取现状保证升级零视觉变化）
 */
export const DEFAULT_TERMINAL_FONT_SIZE = 13;

/**
 * 任意数值归一到最近合法档位（损坏 DB 值归一——15 → 14，非整域丢弃）
 *
 * 非有限数（undefined/NaN/Infinity，即「缺失或彻底损坏」）→ DEFAULT_TERMINAL_FONT_SIZE：
 * NaN 比较全 false 会把结果停在数组首项，必须前置拦截（35 号 clampZoom 同款教训）。
 */
export function clampFontSize(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }
  let nearest = TERMINAL_FONT_SIZES[0] as number;
  let best = Number.POSITIVE_INFINITY;
  for (const size of TERMINAL_FONT_SIZES) {
    const dist = Math.abs(size - value);
    if (dist < best) {
      best = dist;
      nearest = size;
    }
  }
  return nearest;
}
