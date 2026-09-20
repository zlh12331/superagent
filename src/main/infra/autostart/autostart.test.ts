// src/main/infra/autostart/autostart.test.ts
// 开机自启模块单测：三平台读写分支 / 写后回读 / 静默启动判定
// ──────────────────────────────────────────────────────────────
// 这些用例锚定的是三处真机缺陷（2026-09-20 复核报告）：
// - Windows 读取必须用 executableWillLaunchAtLogin 且路径带引号（否则 UI 恒显关闭
//   且无法关闭自启）；断言读请求的参数形状即回归锚
// - 写后必须回读真实状态（此前 handler 回显入参 ⇒ Linux 空实现/macOS 待审批都被
//   显示为"成功"）
// - Linux 自行实现 XDG autostart（Electron 的实现是空函数）
// - --hidden / wasOpenedAtLogin 的静默启动判定
// ──────────────────────────────────────────────────────────────

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 模块顶层 import electron（createAutostartDeps 用）；用例全部注入 fake deps，
// 这里 mock 仅避免测试进程触碰真实 Electron API
vi.mock('electron', () => ({ app: {} }));

import {
  AUTOSTART_HIDDEN_ARG,
  type AutostartAdapter,
  type AutostartDeps,
  buildLinuxDesktopEntry,
  createAutostartDeps,
  isAutostartSupported,
  isLinuxEntryActive,
  linuxAutostartFilePath,
  readAutostartState,
  resolveStartHidden,
  setAutostartEnabled,
  shouldStartHidden,
} from './autostart';

const EXEC_PATH = 'E:\\apps\\Code Agent Desktop\\Code Agent Desktop.exe';

/** 记录调用并可编程返回的 fake 适配器 */
function createFakeAdapter(raw?: {
  executableWillLaunchAtLogin?: boolean;
  openAtLogin?: boolean;
  status?: string;
  wasOpenedAtLogin?: boolean;
}): {
  adapter: AutostartAdapter;
  setCalls: Array<{ openAtLogin: boolean; path?: string; args?: string[] }>;
  getCalls: Array<{ path?: string; args?: string[] } | undefined>;
} {
  const setCalls: Array<{ openAtLogin: boolean; path?: string; args?: string[] }> = [];
  const getCalls: Array<{ path?: string; args?: string[] } | undefined> = [];
  const adapter: AutostartAdapter = {
    setLoginItemSettings: (settings) => {
      setCalls.push(settings);
    },
    getLoginItemSettings: (options) => {
      getCalls.push(options);
      return {
        openAtLogin: raw?.openAtLogin ?? false,
        ...(raw?.executableWillLaunchAtLogin !== undefined
          ? { executableWillLaunchAtLogin: raw.executableWillLaunchAtLogin }
          : {}),
        ...(raw?.status !== undefined ? { status: raw.status } : {}),
        ...(raw?.wasOpenedAtLogin !== undefined ? { wasOpenedAtLogin: raw.wasOpenedAtLogin } : {}),
      };
    },
  };
  return { adapter, setCalls, getCalls };
}

function createDeps(
  platform: NodeJS.Platform,
  adapter: AutostartAdapter,
  overrides?: Partial<AutostartDeps>,
): AutostartDeps {
  return {
    isPackaged: true,
    platform,
    execPath: EXEC_PATH,
    homeDir: overrides?.homeDir ?? '/home/mock',
    adapter,
    ...overrides,
  };
}

describe('autostart', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'autostart-test-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  describe('isAutostartSupported', () => {
    it('未打包（dev）→ 不支持（避免把 electron.exe 写进注册表污染开发机）', () => {
      const { adapter } = createFakeAdapter();
      expect(isAutostartSupported(createDeps('win32', adapter, { isPackaged: false }))).toBe(false);
    });

    it('三平台打包版均支持', () => {
      const { adapter } = createFakeAdapter();
      for (const platform of ['win32', 'darwin', 'linux'] as const) {
        expect(isAutostartSupported(createDeps(platform, adapter))).toBe(true);
      }
    });
  });

  describe('未打包环境（dev 守卫）', () => {
    it('读返回 supported=false 且不触碰适配器', async () => {
      const { adapter, getCalls } = createFakeAdapter();
      const state = await readAutostartState(createDeps('win32', adapter, { isPackaged: false }));
      expect(state).toEqual({ openAtLogin: false, supported: false, requiresApproval: false });
      expect(getCalls).toHaveLength(0);
    });

    it('写为空操作且不写 OS（此前 dev 会把 electron 写进 HKCU\\Run）', async () => {
      const { adapter, setCalls } = createFakeAdapter();
      const state = await setAutostartEnabled(
        createDeps('win32', adapter, { isPackaged: false }),
        true,
      );
      expect(state.supported).toBe(false);
      expect(setCalls).toHaveLength(0);
    });
  });

  describe('Windows', () => {
    it('读取用 executableWillLaunchAtLogin，且路径带引号（回归锚：不带引号实测恒 false）', async () => {
      const { adapter, getCalls } = createFakeAdapter({ executableWillLaunchAtLogin: true });
      const state = await readAutostartState(createDeps('win32', adapter));
      expect(state.openAtLogin).toBe(true);
      expect(getCalls[0]?.path).toBe(`"${EXEC_PATH}"`);
    });

    it('读取：executableWillLaunchAtLogin=false → 未启用（含任务管理器禁用态）', async () => {
      const { adapter } = createFakeAdapter({ executableWillLaunchAtLogin: false });
      expect((await readAutostartState(createDeps('win32', adapter))).openAtLogin).toBe(false);
    });

    it('读取：字段缺失（老版本 Electron）→ 保守判未启用，不抛错', async () => {
      const { adapter } = createFakeAdapter({ openAtLogin: true });
      expect((await readAutostartState(createDeps('win32', adapter))).openAtLogin).toBe(false);
    });

    it('写入：带 --hidden 参数 + 写后回读真实状态', async () => {
      const { adapter, setCalls, getCalls } = createFakeAdapter({
        executableWillLaunchAtLogin: true,
      });
      const state = await setAutostartEnabled(createDeps('win32', adapter), true);
      expect(setCalls[0]).toEqual({
        openAtLogin: true,
        path: EXEC_PATH,
        args: [AUTOSTART_HIDDEN_ARG],
      });
      // 回读（而非回显入参）
      expect(getCalls.length).toBeGreaterThan(0);
      expect(state.openAtLogin).toBe(true);
    });

    it('写入后回读为未启用（注册失败）→ 如实返回 false，不伪装成功', async () => {
      const { adapter } = createFakeAdapter({ executableWillLaunchAtLogin: false });
      const state = await setAutostartEnabled(createDeps('win32', adapter), true);
      expect(state).toEqual({ openAtLogin: false, supported: true, requiresApproval: false });
    });

    it('关闭：openAtLogin=false 且回读为 false', async () => {
      const { adapter, setCalls } = createFakeAdapter({ executableWillLaunchAtLogin: false });
      const state = await setAutostartEnabled(createDeps('win32', adapter), false);
      expect(setCalls[0]?.openAtLogin).toBe(false);
      expect(state.openAtLogin).toBe(false);
    });

    it('读取抛错 → 判未启用但不抛（不阻断界面）', async () => {
      const adapter: AutostartAdapter = {
        setLoginItemSettings: vi.fn(),
        getLoginItemSettings: () => {
          throw new Error('registry unavailable');
        },
      };
      expect(await readAutostartState(createDeps('win32', adapter))).toEqual({
        openAtLogin: false,
        supported: true,
        requiresApproval: false,
      });
    });
  });

  describe('macOS', () => {
    it('status=enabled → 已启用', async () => {
      const { adapter } = createFakeAdapter({ openAtLogin: true, status: 'enabled' });
      expect(await readAutostartState(createDeps('darwin', adapter))).toEqual({
        openAtLogin: true,
        supported: true,
        requiresApproval: false,
      });
    });

    it('status=requires-approval → 未启用但透传待批准（否则 UI 显示"已关"而实际已注册）', async () => {
      const { adapter } = createFakeAdapter({ openAtLogin: false, status: 'requires-approval' });
      expect(await readAutostartState(createDeps('darwin', adapter))).toEqual({
        openAtLogin: false,
        supported: true,
        requiresApproval: true,
      });
    });

    it('写入不传 args（ServiceManagement 忽略 args，静默启动走 wasOpenedAtLogin）', async () => {
      const { adapter, setCalls } = createFakeAdapter({ openAtLogin: true, status: 'enabled' });
      await setAutostartEnabled(createDeps('darwin', adapter), true);
      expect(setCalls[0]).toEqual({ openAtLogin: true });
    });
  });

  describe('Linux（XDG autostart 自实现）', () => {
    it('未注册 → 未启用', async () => {
      const { adapter } = createFakeAdapter();
      expect((await readAutostartState(createDeps('linux', adapter))).openAtLogin).toBe(false);
    });

    it('写入创建 .desktop 并回读为已启用；关闭则删除文件', async () => {
      const { adapter } = createFakeAdapter();
      const deps = createDeps('linux', adapter, { homeDir });

      const on = await setAutostartEnabled(deps, true);
      expect(on.openAtLogin).toBe(true);
      const content = readFileSync(linuxAutostartFilePath(deps), 'utf8');
      expect(content).toContain(`Exec="${EXEC_PATH}" ${AUTOSTART_HIDDEN_ARG}`);
      expect(content).toContain('X-GNOME-Autostart-enabled=true');
      expect(content.startsWith('[Desktop Entry]')).toBe(true);

      const off = await setAutostartEnabled(deps, false);
      expect(off.openAtLogin).toBe(false);
      expect(() => readFileSync(linuxAutostartFilePath(deps), 'utf8')).toThrow();
    });

    it('X-GNOME-Autostart-enabled=false → 视为未启用', async () => {
      const { adapter } = createFakeAdapter();
      const deps = createDeps('linux', adapter, { homeDir });
      const filePath = linuxAutostartFilePath(deps);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(
        filePath,
        buildLinuxDesktopEntry(EXEC_PATH).replace(
          'X-GNOME-Autostart-enabled=true',
          'X-GNOME-Autostart-enabled=false',
        ),
        'utf8',
      );
      expect((await readAutostartState(deps)).openAtLogin).toBe(false);
    });

    it('Exec 指向其它路径（应用被移动）→ 视为未启用，重新开启可自愈', async () => {
      const { adapter } = createFakeAdapter();
      const deps = createDeps('linux', adapter, { homeDir });
      const filePath = linuxAutostartFilePath(deps);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, buildLinuxDesktopEntry('/old/path/app'), 'utf8');
      expect((await readAutostartState(deps)).openAtLogin).toBe(false);
      expect((await setAutostartEnabled(deps, true)).openAtLogin).toBe(true);
    });

    it('isLinuxEntryActive：缺 Exec 行 → 未启用（不误判）', () => {
      expect(isLinuxEntryActive('[Desktop Entry]\nType=Application\n', EXEC_PATH)).toBe(false);
    });
  });

  describe('shouldStartHidden（--hidden / macOS 登录态）', () => {
    it('argv 含 --hidden → 静默启动（Windows/Linux 路径）', () => {
      expect(
        shouldStartHidden({
          argv: ['app.exe', AUTOSTART_HIDDEN_ARG],
          platform: 'win32',
          wasOpenedAtLogin: false,
        }),
      ).toBe(true);
    });

    it('macOS 登录项启动（无参数）→ 由 wasOpenedAtLogin 判定', () => {
      expect(shouldStartHidden({ argv: ['app'], platform: 'darwin', wasOpenedAtLogin: true })).toBe(
        true,
      );
      expect(
        shouldStartHidden({ argv: ['app'], platform: 'darwin', wasOpenedAtLogin: false }),
      ).toBe(false);
    });

    it('普通启动（无参数、非登录项）→ 正常显示窗口', () => {
      for (const platform of ['win32', 'linux', 'darwin'] as const) {
        expect(shouldStartHidden({ argv: ['app'], platform, wasOpenedAtLogin: false })).toBe(false);
      }
    });

    it('非 macOS 平台忽略 wasOpenedAtLogin（该字段仅 darwin 有意义）', () => {
      expect(shouldStartHidden({ argv: ['app'], platform: 'win32', wasOpenedAtLogin: true })).toBe(
        false,
      );
    });
  });

  describe('createAutostartDeps（生产依赖）', () => {
    it('读取进程级真实值（platform / execPath 非空，homeDir 非空）', () => {
      const deps = createAutostartDeps();
      expect(deps.platform).toBe(process.platform);
      expect(deps.execPath).toBe(process.execPath);
      expect(deps.homeDir.length).toBeGreaterThan(0);
    });
  });

  describe('resolveStartHidden（生产封装）', () => {
    it('argv 含 --hidden 时无须访问适配器即返回 true', () => {
      const original = process.argv;
      process.argv = [...original, AUTOSTART_HIDDEN_ARG];
      try {
        const { adapter, getCalls } = createFakeAdapter();
        expect(resolveStartHidden(adapter)).toBe(true);
        // 非 darwin 宿主不查 wasOpenedAtLogin
        if (process.platform !== 'darwin') {
          expect(getCalls).toHaveLength(0);
        }
      } finally {
        process.argv = original;
      }
    });

    it('普通 argv 且适配器抛错 → 判不隐藏（宁可见，不静默吞窗口）', () => {
      const original = process.argv;
      process.argv = [original[0] ?? 'app'];
      try {
        const adapter: AutostartAdapter = {
          setLoginItemSettings: vi.fn(),
          getLoginItemSettings: () => {
            throw new Error('unavailable');
          },
        };
        expect(resolveStartHidden(adapter)).toBe(false);
      } finally {
        process.argv = original;
      }
    });
  });
});
