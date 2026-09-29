// terminal-section.tsx（36 号 B 新增分区）
// 设置 · 终端（默认 shell 选择 + 字号；对齐 editor/browser 分区形态）
// ──────────────────────────────────────────────
// 设计：
// - shell 档位随平台收敛（shared terminalShellChoicesForPlatform 单一真源），
//   auto = 平台默认；写入的是档位本身（跨平台写入合法，主进程读侧 fail-open 回落）
// - fontSize 为档位制 SegControl（TERMINAL_FONT_SIZES），xterm 实例热更由
//   TerminalView 消费（本组件只写 store）
// - 数据源：settings-store.terminal（persistent），写穿透落 SQLite
// ──────────────────────────────────────────────

import {
  TERMINAL_FONT_SIZES,
  type TerminalPlatform,
  type TerminalShellChoice,
  terminalShellChoicesForPlatform,
} from '@code-agent/shared/renderer';
import { TerminalSquare } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from '@/i18n/use-translation';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { SegControl, SettingRow } from '../settings-controls';

/**
 * 当前平台归一（主进程 process.platform 的渲染层对应物）
 *
 * navigator.platform 先例：各文件自持常量（settings-store IS_MAC 同款手法），
 * 未识别值归 linux（Unix 侧选项表是 bash/zsh/fish 的超集语义，fail-open）。
 */
const TERMINAL_PLATFORM: TerminalPlatform =
  typeof navigator !== 'undefined' && navigator.platform?.toLowerCase().includes('win') === true
    ? 'windows'
    : typeof navigator !== 'undefined' && navigator.platform?.toLowerCase().includes('mac') === true
      ? 'macos'
      : 'linux';

/** shell 档位 i18n key（与 TERMINAL_SHELL_CHOICES 档位一一对应） */
const SHELL_LABEL_KEYS: Record<string, string> = {
  auto: 'settings.terminal.shellAuto',
  powershell: 'settings.terminal.shellPowershell',
  cmd: 'settings.terminal.shellCmd',
  gitbash: 'settings.terminal.shellGitBash',
  wsl: 'settings.terminal.shellWsl',
  bash: 'settings.terminal.shellBash',
  zsh: 'settings.terminal.shellZsh',
  fish: 'settings.terminal.shellFish',
};

/** 终端设置分区 */
export function TerminalSection(): ReactElement {
  const { t } = useTranslation();
  const terminal = useSettingsStore((s) => s.terminal);
  const updateTerminal = useSettingsStore((s) => s.updateTerminal);

  const shellOptions = terminalShellChoicesForPlatform(TERMINAL_PLATFORM).map((choice) => ({
    value: choice,
    label: t(SHELL_LABEL_KEYS[choice] ?? 'settings.terminal.shellAuto'),
  }));
  const fontOptions = TERMINAL_FONT_SIZES.map((size) => ({
    value: String(size),
    label: String(size),
  }));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <TerminalSquare className="text-muted-foreground size-4" strokeWidth={1.5} />
        <h3 className="text-foreground text-sm font-semibold">{t('settings.terminal.title')}</h3>
      </div>
      <div className="mt-2 flex flex-col gap-2">
        <SettingRow label={t('settings.terminal.shellLabel')}>
          <SegControl
            value={terminal.shell}
            onChange={(value) => updateTerminal({ shell: value as TerminalShellChoice })}
            options={shellOptions}
          />
        </SettingRow>
        <p className="text-muted-foreground text-xs font-sans">
          {t('settings.terminal.shellDesc')}
        </p>
        <SettingRow label={t('settings.terminal.fontSizeLabel')}>
          <SegControl
            value={String(terminal.fontSize)}
            onChange={(value) => updateTerminal({ fontSize: Number(value) })}
            options={fontOptions}
          />
        </SettingRow>
      </div>
    </div>
  );
}
