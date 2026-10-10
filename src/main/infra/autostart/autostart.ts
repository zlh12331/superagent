import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { app } from 'electron';

import { logger } from '../../utils/logger';

export const AUTOSTART_HIDDEN_ARG = '--hidden';

const LINUX_AUTOSTART_FILE = 'code-agent-desktop.desktop';

const APP_DISPLAY_NAME = 'Code Agent Desktop';

export interface AutostartState {
  readonly openAtLogin: boolean;
  readonly supported: boolean;
  readonly requiresApproval: boolean;
}

export interface RawLoginItemSettings {
  readonly openAtLogin: boolean;
  readonly executableWillLaunchAtLogin?: boolean;
  readonly status?: string;
  readonly wasOpenedAtLogin?: boolean;
}

export interface AutostartAdapter {
  setLoginItemSettings(settings: {
    readonly openAtLogin: boolean;
    readonly path?: string;
    readonly args?: string[];
  }): void;
  getLoginItemSettings(options?: {
    readonly path?: string;
    readonly args?: string[];
  }): RawLoginItemSettings;
}

export interface AutostartDeps {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  readonly homeDir: string;
  readonly xdgConfigHome?: string;
  readonly adapter: AutostartAdapter;
}

export function resolveAutostartExecPath(
  platform: NodeJS.Platform,
  appImage: string | undefined,
): string {
  if (platform === 'linux' && appImage !== undefined && appImage !== '') {
    return appImage;
  }
  return process.execPath;
}

export function createAutostartDeps(): AutostartDeps {
  const xdgConfigHome = process.env['XDG_CONFIG_HOME'];
  return {
    isPackaged: app.isPackaged,
    platform: process.platform,
    execPath: resolveAutostartExecPath(process.platform, process.env['APPIMAGE']),
    homeDir: homedir(),
    ...(xdgConfigHome !== undefined && xdgConfigHome !== '' ? { xdgConfigHome } : {}),
    adapter: app,
  };
}

export function isAutostartSupported(deps: AutostartDeps): boolean {
  if (!deps.isPackaged) {
    return false;
  }
  return deps.platform === 'win32' || deps.platform === 'darwin' || deps.platform === 'linux';
}

export async function readAutostartState(deps: AutostartDeps): Promise<AutostartState> {
  if (!isAutostartSupported(deps)) {
    return { openAtLogin: false, supported: false, requiresApproval: false };
  }
  try {
    if (deps.platform === 'win32') {
      return { ...readWindowsState(deps), supported: true };
    }
    if (deps.platform === 'darwin') {
      return { ...readMacState(deps), supported: true };
    }
    return { ...readLinuxState(deps), supported: true, requiresApproval: false };
  } catch (error) {
    logger.warn(
      { platform: deps.platform, error: error instanceof Error ? error.message : String(error) },
      '读取开机自启状态失败（按未启用处理，界面对应显示关闭）',
    );
    return { openAtLogin: false, supported: true, requiresApproval: false };
  }
}

export async function setAutostartEnabled(
  deps: AutostartDeps,
  enabled: boolean,
): Promise<AutostartState> {
  if (!isAutostartSupported(deps)) {
    logger.info(
      { platform: deps.platform, enabled, isPackaged: deps.isPackaged },
      '开机自启写入被跳过（当前环境不支持：仅打包后可用）',
    );
    return { openAtLogin: false, supported: false, requiresApproval: false };
  }
  try {
    if (deps.platform === 'win32') {
      deps.adapter.setLoginItemSettings({
        openAtLogin: enabled,
        path: deps.execPath,
        args: [AUTOSTART_HIDDEN_ARG],
      });
    } else if (deps.platform === 'darwin') {
      deps.adapter.setLoginItemSettings({ openAtLogin: enabled });
    } else {
      writeLinuxState(deps, enabled);
    }
  } catch (error) {
    logger.error(
      {
        platform: deps.platform,
        enabled,
        execPath: deps.execPath,
        error: error instanceof Error ? error.message : String(error),
      },
      '写入开机自启失败',
    );
    throw error;
  }
  const state = await readAutostartState(deps);
  logger.info(
    { platform: deps.platform, requested: enabled, state, execPath: deps.execPath },
    '开机自启已变更（state 为写入后的真实回读值）',
  );
  return state;
}

function readWindowsState(deps: AutostartDeps): {
  readonly openAtLogin: boolean;
  readonly requiresApproval: boolean;
} {
  const raw = deps.adapter.getLoginItemSettings({ path: quoteForCommandLine(deps.execPath) });
  return { openAtLogin: raw.executableWillLaunchAtLogin === true, requiresApproval: false };
}

function readMacState(deps: AutostartDeps): {
  readonly openAtLogin: boolean;
  readonly requiresApproval: boolean;
} {
  const raw = deps.adapter.getLoginItemSettings();
  return {
    openAtLogin: raw.openAtLogin,
    requiresApproval: raw.status === 'requires-approval',
  };
}

export function linuxAutostartFilePath(deps: AutostartDeps): string {
  const configHome =
    deps.xdgConfigHome !== undefined && deps.xdgConfigHome !== ''
      ? deps.xdgConfigHome
      : join(deps.homeDir, '.config');
  return join(configHome, 'autostart', LINUX_AUTOSTART_FILE);
}

export function buildLinuxDesktopEntry(execPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${APP_DISPLAY_NAME}`,
    `Exec=${quoteForCommandLine(execPath)} ${AUTOSTART_HIDDEN_ARG}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export interface LinuxEntryVerdict {
  readonly active: boolean;
  readonly reason: string;
}

export function evaluateLinuxEntry(content: string, execPath: string): LinuxEntryVerdict {
  if (/^\s*Hidden\s*=\s*true\s*$/m.test(content)) {
    return { active: false, reason: 'Hidden=true（桌面环境已禁用该条目）' };
  }
  if (/^\s*X-GNOME-Autostart-enabled\s*=\s*false\s*$/m.test(content)) {
    return { active: false, reason: 'X-GNOME-Autostart-enabled=false' };
  }
  const execLine = content.match(/^Exec\s*=\s*(.+)$/m)?.[1];
  if (execLine === undefined) {
    return { active: false, reason: '缺少 Exec 行' };
  }
  const expected = `${quoteForCommandLine(execPath)} ${AUTOSTART_HIDDEN_ARG}`;
  if (execLine.trim() !== expected) {
    return { active: false, reason: `Exec 指向 ${execLine.trim()}（期望 ${expected}）` };
  }
  return { active: true, reason: 'Exec 与 X-GNOME-Autostart-enabled 均匹配' };
}

export function isLinuxEntryActive(content: string, execPath: string): boolean {
  return evaluateLinuxEntry(content, execPath).active;
}

function readLinuxState(deps: AutostartDeps): { readonly openAtLogin: boolean } {
  const filePath = linuxAutostartFilePath(deps);
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') {
      return { openAtLogin: false };
    }
    throw error;
  }
  const verdict = evaluateLinuxEntry(content, deps.execPath);
  if (!verdict.active) {
    logger.info({ filePath, reason: verdict.reason }, 'Linux 自启条目存在但判定为未启用');
  }
  return { openAtLogin: verdict.active };
}

function writeLinuxState(deps: AutostartDeps, enabled: boolean): void {
  const filePath = linuxAutostartFilePath(deps);
  if (!enabled) {
    rmSync(filePath, { force: true });
    return;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, buildLinuxDesktopEntry(deps.execPath), 'utf8');
}

export interface StartHiddenInput {
  readonly argv: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly wasOpenedAtLogin: boolean;
}

export function shouldStartHidden(input: StartHiddenInput): boolean {
  if (input.argv.includes(AUTOSTART_HIDDEN_ARG)) {
    return true;
  }
  return input.platform === 'darwin' && input.wasOpenedAtLogin;
}

export function resolveStartHidden(adapter: AutostartAdapter): boolean {
  let wasOpenedAtLogin = false;
  if (process.platform === 'darwin') {
    try {
      wasOpenedAtLogin = adapter.getLoginItemSettings().wasOpenedAtLogin === true;
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        '读取 wasOpenedAtLogin 失败（按"非登录启动"处理，窗口正常显示）',
      );
      wasOpenedAtLogin = false;
    }
  }
  return shouldStartHidden({
    argv: process.argv,
    platform: process.platform,
    wasOpenedAtLogin,
  });
}

function quoteForCommandLine(value: string): string {
  return `"${value}"`;
}
