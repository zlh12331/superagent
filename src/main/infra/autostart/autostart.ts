// autostart.ts：开机自启三平台实现——win/darwin 走 Electron LoginItemSettings，
// Linux 手写 XDG autostart .desktop 条目（Electron 在 Linux 上不可靠）
// 依赖全部经 AutostartDeps 注入（adapter=app 可替换），判定/构建函数纯函数化供测试
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { app } from 'electron';

import { logger } from '../../utils/logger';

// 自启拉起带 --hidden：静默驻留托盘不弹窗（30 号驻留规格）
export const AUTOSTART_HIDDEN_ARG = '--hidden';

const LINUX_AUTOSTART_FILE = 'code-agent-desktop.desktop';

const APP_DISPLAY_NAME = 'Code Agent Desktop';

/** 自启状态三元组：是否启用 / 平台是否支持 / macOS 是否待用户在系统设置里确认 */
export interface AutostartState {
  readonly openAtLogin: boolean;
  readonly supported: boolean;
  readonly requiresApproval: boolean;
}

/** Electron getLoginItemSettings 的原始返回（字段随平台而异，读侧自行判读） */
export interface RawLoginItemSettings {
  readonly openAtLogin: boolean;
  readonly executableWillLaunchAtLogin?: boolean;
  readonly status?: string;
  readonly wasOpenedAtLogin?: boolean;
}

/** app 登录项能力的最小接口（DI 缝：测试用 fake 替换真实 electron app） */
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

/** 平台环境依赖：打包态/平台/可执行路径/用户目录/Linux 配置根 + adapter */
export interface AutostartDeps {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  readonly homeDir: string;
  readonly xdgConfigHome?: string;
  readonly adapter: AutostartAdapter;
}

/**
 * 自启要登记的可执行路径：AppImage 场景必须用 $APPIMAGE 环境变量——
 * execPath 指向 /tmp/.mount_* 挂载点，重启后该路径不存在，登记了也拉不起来
 */
export function resolveAutostartExecPath(
  platform: NodeJS.Platform,
  appImage: string | undefined,
): string {
  if (platform === 'linux' && appImage !== undefined && appImage !== '') {
    return appImage;
  }
  return process.execPath;
}

/** 从真实运行环境收集依赖（生产入口；测试自建 deps） */
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

/** 仅打包后的三平台支持自启（dev 登记只会拉起 electron 二进制，无意义） */
export function isAutostartSupported(deps: AutostartDeps): boolean {
  if (!deps.isPackaged) {
    return false;
  }
  return deps.platform === 'win32' || deps.platform === 'darwin' || deps.platform === 'linux';
}

/**
 * 读自启状态（平台分派；读取失败按「未启用」兜底——界面对应显示关闭，不炸设置面）
 *
 * macOS 可能返回 requiresApproval=true：用户还需在系统设置里放行
 */
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

/**
 * 写自启开关（平台分派），写完强制回读真实状态返回——写入成功≠生效（macOS 审批态），
 * 返回值以回读为准（托盘勾选与广播的 payload 都用它）
 */
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

// Windows 按 path+args 匹配已登记项，path 必须带引号（含空格路径；Electron 匹配是字面比较）
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

/** XDG autostart 条目路径（尊重 XDG_CONFIG_HOME，缺省 ~/.config） */
export function linuxAutostartFilePath(deps: AutostartDeps): string {
  const configHome =
    deps.xdgConfigHome !== undefined && deps.xdgConfigHome !== ''
      ? deps.xdgConfigHome
      : join(deps.homeDir, '.config');
  return join(configHome, 'autostart', LINUX_AUTOSTART_FILE);
}

/** 构建 .desktop 条目内容（Exec 带 --hidden；桌面环境按此文件决定登录拉起） */
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

/**
 * 判定 .desktop 条目是否真正生效：Hidden=true / X-GNOME-Autostart-enabled=false / 缺 Exec /
 * Exec 与期望登记值不符（用户手改或版本路径变化）都算未启用——不做盲目布尔推断
 */
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

/** 静默启动判定：argv 带 --hidden（win/linux 自启）或 macOS 登录拉起（wasOpenedAtLogin） */
export function shouldStartHidden(input: StartHiddenInput): boolean {
  if (input.argv.includes(AUTOSTART_HIDDEN_ARG)) {
    return true;
  }
  return input.platform === 'darwin' && input.wasOpenedAtLogin;
}

/**
 * 生产入口：从 process.argv / platform / macOS 登录态判定本次启动是否应隐藏窗口
 *
 * wasOpenedAtLogin 读取失败按「非登录启动」处理（窗口正常显示）——误隐藏比误显示更伤
 */
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

// 登记路径带空格须引号包裹（Windows LoginItem 匹配是字面比较，见 readWindowsState）
function quoteForCommandLine(value: string): string {
  return `"${value}"`;
}
