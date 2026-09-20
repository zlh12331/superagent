// src/main/infra/autostart/autostart.ts
// 开机自启（OS 登录项）读写 · 平台差异抹平 · 真实状态回读
// ──────────────────────────────────────────────────────────────
// 独立成模块的原因：Electron 的 loginItem API 三平台语义差异极大（2026-09-20 读
// Electron v44 源码 + Windows 实测核实），散落在 handler/tray 两处会各自踩坑：
//
// - win32：写 HKCU\...\Run 的命令行；**读取的 openAtLogin 是与写入命令行的逐字符
//   比对**（args 少一个即 false），而 executableWillLaunchAtLogin 才是「该 exe 是否
//   会在登录时启动」（忽略 args，且反映任务管理器的禁用态）。实测：不带 args 读 →
//   false（界面恒显关闭、且无法关闭自启），带 args 读 → true。本模块统一用后者；
//   其路径**必须带引号**（否则含空格的路径被按命令行解析后匹配失败，同为实测结论）。
// - darwin：走 ServiceManagement，**args 被忽略**（--hidden 到不了应用）⇒ 静默启动
//   改由启动期读一次 wasOpenedAtLogin 判定；status 可能是 requires-approval
//   （macOS 13+ 需用户在系统设置批准），必须透传——否则界面显示「已关」而实际已注册。
// - linux：Electron 的 SetLoginItemSettings 是**空函数**、Get 返回默认值 ⇒ 直接用它
//   就是「假成功」（界面显示已开、系统什么都没发生）。本模块自行实现 XDG autostart
//   （~/.config/autostart/*.desktop），这是 Linux 桌面通用的自启机制。
// - 未打包（dev）：不做任何注册（macOS 未打包注册不可靠；Windows 会把 electron.exe
//   写进注册表污染开发机）——supported=false，界面据此禁用并说明。
//
// 写后一律**回读真实状态**返回：任何平台的静默失败（注册表写入异常、审批未通过、
// 文件写失败）都不会被伪装成成功。
// ──────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { app } from 'electron';

/** 开机自启时的启动参数（Windows 写入 Run 项；macOS 忽略该参数，见文件头） */
export const AUTOSTART_HIDDEN_ARG = '--hidden';

/** Linux XDG autostart 文件相对 home 的路径片段 */
const LINUX_AUTOSTART_RELATIVE = ['.config', 'autostart', 'code-agent-desktop.desktop'] as const;

/** 应用显示名（仅用于 Linux .desktop 的 Name 字段） */
const APP_DISPLAY_NAME = 'Code Agent Desktop';

/** 开机自启状态（IPC 响应的语义定义处，见 packages/shared/src/schemas/app.ts） */
export interface AutostartState {
  /** OS 登录项是否处于启用态（真实读取，非回显入参） */
  readonly openAtLogin: boolean;
  /** 当前环境是否支持该开关（未打包、或平台无实现时为 false） */
  readonly supported: boolean;
  /** macOS 13+：已注册但等待用户在系统设置中批准 */
  readonly requiresApproval: boolean;
}

/** Electron getLoginItemSettings 返回值的可注入子集 */
export interface RawLoginItemSettings {
  readonly openAtLogin: boolean;
  readonly executableWillLaunchAtLogin?: boolean;
  readonly status?: string;
  readonly wasOpenedAtLogin?: boolean;
}

/** Electron app 登录项 API 的可注入子集（测试注入 fake，不 mock 模块） */
export interface AutostartAdapter {
  /** 写入 OS 登录项 */
  setLoginItemSettings(settings: {
    readonly openAtLogin: boolean;
    readonly path?: string;
    readonly args?: string[];
  }): void;
  /** 读取 OS 登录项 */
  getLoginItemSettings(options?: {
    readonly path?: string;
    readonly args?: string[];
  }): RawLoginItemSettings;
}

/** 自启读写依赖（平台/路径/适配器全部注入，测试可在任意宿主覆盖三分支） */
export interface AutostartDeps {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  readonly homeDir: string;
  readonly adapter: AutostartAdapter;
}

/** 生产依赖：读真实 Electron / 平台 / 路径 */
export function createAutostartDeps(): AutostartDeps {
  return {
    isPackaged: app.isPackaged,
    platform: process.platform,
    execPath: process.execPath,
    homeDir: homedir(),
    adapter: app,
  };
}

/** 当前环境是否支持自启开关（未打包一律不支持，避免污染开发机） */
export function isAutostartSupported(deps: AutostartDeps): boolean {
  if (!deps.isPackaged) {
    return false;
  }
  return deps.platform === 'win32' || deps.platform === 'darwin' || deps.platform === 'linux';
}

/**
 * 读取真实自启状态
 *
 * 读失败（API 抛错 / 文件不可读）按「未启用 + 支持」处理：不阻断界面，
 * 用户重新开启时写入路径会自愈。
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
    return { openAtLogin: readLinuxState(deps), supported: true, requiresApproval: false };
  } catch {
    return { openAtLogin: false, supported: true, requiresApproval: false };
  }
}

/**
 * 写入自启状态并**回读真实结果**返回
 *
 * 返回的是写入后重新读取的 OS 状态，而非入参回显——注册失败 / 审批未通过 /
 * 文件写失败都会如实反映（界面开关随之回到真实位置）。
 */
export async function setAutostartEnabled(
  deps: AutostartDeps,
  enabled: boolean,
): Promise<AutostartState> {
  if (!isAutostartSupported(deps)) {
    return { openAtLogin: false, supported: false, requiresApproval: false };
  }
  if (deps.platform === 'win32') {
    deps.adapter.setLoginItemSettings({
      openAtLogin: enabled,
      path: deps.execPath,
      args: [AUTOSTART_HIDDEN_ARG],
    });
  } else if (deps.platform === 'darwin') {
    // macOS：args 被 ServiceManagement 忽略（--hidden 无法传递），静默启动由
    // wasOpenedAtLogin 兜底，故不传 args
    deps.adapter.setLoginItemSettings({ openAtLogin: enabled });
  } else {
    writeLinuxState(deps, enabled);
  }
  return await readAutostartState(deps);
}

// ── Windows ──

/**
 * Windows 读取
 *
 * 路径带引号是硬要求（源码 CommandLine::FromString(options.path).GetProgram()
 * 会把未加引号的含空格路径截断，导致匹配失败，实测 executableWillLaunchAtLogin
 * 在未加引号时恒为 false）。
 */
function readWindowsState(deps: AutostartDeps): {
  readonly openAtLogin: boolean;
  readonly requiresApproval: boolean;
} {
  const raw = deps.adapter.getLoginItemSettings({ path: quoteForCommandLine(deps.execPath) });
  return { openAtLogin: raw.executableWillLaunchAtLogin === true, requiresApproval: false };
}

// ── macOS ──

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

// ── Linux（XDG autostart，自行实现）──

/** Linux 自启文件路径 */
export function linuxAutostartFilePath(deps: AutostartDeps): string {
  return join(deps.homeDir, ...LINUX_AUTOSTART_RELATIVE);
}

/**
 * 构造 .desktop 内容（纯函数，导出便于测试断言格式）
 *
 * 遵循 XDG Desktop Entry 规范 + GNOME 的 X-GNOME-Autostart-enabled 扩展键；
 * Exec 路径带引号（路径可能含空格）。
 */
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

/**
 * 判断 .desktop 内容是否指向「本应用且启用」（纯函数）
 *
 * 指向其它路径（应用被移动/重装到新目录）视为未启用——此时开关显示关闭，
 * 重新开启会重写文件，属自愈路径。
 */
export function isLinuxEntryActive(content: string, execPath: string): boolean {
  if (/^X-GNOME-Autostart-enabled\s*=\s*false\s*$/m.test(content)) {
    return false;
  }
  const execLine = content.match(/^Exec\s*=\s*(.+)$/m)?.[1];
  if (execLine === undefined) {
    return false;
  }
  return execLine.trim() === `${quoteForCommandLine(execPath)} ${AUTOSTART_HIDDEN_ARG}`;
}

function readLinuxState(deps: AutostartDeps): boolean {
  const filePath = linuxAutostartFilePath(deps);
  try {
    return isLinuxEntryActive(readFileSync(filePath, 'utf8'), deps.execPath);
  } catch {
    // 文件不存在或不可读：未启用
    return false;
  }
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

// ── 静默启动（--hidden 判定）──

/** 静默启动判定输入（纯函数入参，便于测试） */
export interface StartHiddenInput {
  readonly argv: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly wasOpenedAtLogin: boolean;
}

/**
 * 启动时是否不显示主窗口（仅驻留托盘）
 *
 * 两条来源：Windows/Linux 走 `--hidden` 启动参数；macOS 上登录项启动不携带
 * 参数（Electron 忽略 args），改用系统提供的 wasOpenedAtLogin。
 */
export function shouldStartHidden(input: StartHiddenInput): boolean {
  if (input.argv.includes(AUTOSTART_HIDDEN_ARG)) {
    return true;
  }
  return input.platform === 'darwin' && input.wasOpenedAtLogin;
}

/** 生产封装：读真实 argv / 平台 / macOS 登录态（读失败按不隐藏，宁可见） */
export function resolveStartHidden(adapter: AutostartAdapter): boolean {
  let wasOpenedAtLogin = false;
  if (process.platform === 'darwin') {
    try {
      wasOpenedAtLogin = adapter.getLoginItemSettings().wasOpenedAtLogin === true;
    } catch {
      wasOpenedAtLogin = false;
    }
  }
  return shouldStartHidden({
    argv: process.argv,
    platform: process.platform,
    wasOpenedAtLogin,
  });
}

/** 命令行引号包裹（与 Electron 内部 FormatCommandLineString 的口径对齐） */
function quoteForCommandLine(value: string): string {
  return `"${value}"`;
}

/** 自启文件是否存在（供诊断/测试断言；不参与业务判断） */
export function linuxAutostartFileExists(deps: AutostartDeps): boolean {
  return existsSync(linuxAutostartFilePath(deps));
}
