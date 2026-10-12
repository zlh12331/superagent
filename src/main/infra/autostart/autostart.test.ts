import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {} }));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  AUTOSTART_HIDDEN_ARG,
  type AutostartAdapter,
  type AutostartDeps,
  buildLinuxDesktopEntry,
  createAutostartDeps,
  evaluateLinuxEntry,
  isAutostartSupported,
  isLinuxEntryActive,
  linuxAutostartFilePath,
  readAutostartState,
  resolveAutostartExecPath,
  resolveStartHidden,
  setAutostartEnabled,
  shouldStartHidden,
} from './autostart';

const EXEC_PATH = 'E:\\apps\\Code Agent Desktop\\Code Agent Desktop.exe';

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
      if (process.platform === 'linux' && process.env['APPIMAGE'] !== undefined) {
        expect(deps.execPath).toBe(process.env['APPIMAGE']);
      } else {
        expect(deps.execPath).toBe(process.execPath);
      }
      expect(deps.homeDir.length).toBeGreaterThan(0);
    });
  });

  describe('resolveAutostartExecPath（AppImage 用 $APPIMAGE，修 P1-1）', () => {
    it('linux + 有 APPIMAGE → 用 APPIMAGE（execPath 是临时挂载点，每次启动都变）', () => {
      expect(resolveAutostartExecPath('linux', '/home/u/Apps/CodeAgent.AppImage')).toBe(
        '/home/u/Apps/CodeAgent.AppImage',
      );
    });

    it('linux 无 APPIMAGE（deb/rpm 安装）→ 回退 execPath', () => {
      expect(resolveAutostartExecPath('linux', undefined)).toBe(process.execPath);
    });

    it('linux + 空字符串 APPIMAGE → 回退 execPath（不写空路径）', () => {
      expect(resolveAutostartExecPath('linux', '')).toBe(process.execPath);
    });

    it('非 linux 平台即使有 APPIMAGE 也不采用（该变量只在 AppImage 运行时存在）', () => {
      expect(resolveAutostartExecPath('win32', '/tmp/x.AppImage')).toBe(process.execPath);
      expect(resolveAutostartExecPath('darwin', '/tmp/x.AppImage')).toBe(process.execPath);
    });

    it('AppImage 场景下写入的 .desktop 指向真实文件而非挂载点', async () => {
      const { adapter } = createFakeAdapter();
      const appImagePath = '/home/u/Apps/CodeAgent-1.3.3.AppImage';
      const deps = createDeps('linux', adapter, {
        homeDir,
        execPath: resolveAutostartExecPath('linux', appImagePath),
      });

      const state = await setAutostartEnabled(deps, true);

      expect(state.openAtLogin).toBe(true);
      const content = readFileSync(linuxAutostartFilePath(deps), 'utf8');
      expect(content).toContain(`Exec="${appImagePath}" ${AUTOSTART_HIDDEN_ARG}`);
      expect(content).not.toContain('/tmp/.mount_');
    });
  });

  describe('linuxAutostartFilePath（遵循 XDG_CONFIG_HOME，修 P2-3）', () => {
    it('设置 xdgConfigHome 时使用它（与 update-cache 的 XDG_CACHE_HOME 口径一致）', () => {
      const deps = createDeps('linux', createFakeAdapter().adapter, {
        homeDir: '/home/mock',
        xdgConfigHome: '/custom/config',
      });
      expect(linuxAutostartFilePath(deps)).toBe(
        join('/custom/config', 'autostart', 'code-agent-desktop.desktop'),
      );
    });

    it('未设置 xdgConfigHome 时回退 ~/.config', () => {
      const deps = createDeps('linux', createFakeAdapter().adapter, { homeDir: '/home/mock' });
      expect(linuxAutostartFilePath(deps)).toBe(
        join('/home/mock', '.config', 'autostart', 'code-agent-desktop.desktop'),
      );
    });
  });

  describe('evaluateLinuxEntry（Hidden=true 语义，修 P2-4）', () => {
    const expectedExec = `"${EXEC_PATH}" ${AUTOSTART_HIDDEN_ARG}`;

    it('Hidden=true（KDE 等禁用写法）→ 未启用，即使 Exec 与 X-GNOME 键都正常', () => {
      const content = [
        '[Desktop Entry]',
        'Type=Application',
        `Exec=${expectedExec}`,
        'X-GNOME-Autostart-enabled=true',
        'Hidden=true',
        '',
      ].join('\n');
      const verdict = evaluateLinuxEntry(content, EXEC_PATH);
      expect(verdict.active).toBe(false);
      expect(verdict.reason).toContain('Hidden=true');
      expect(isLinuxEntryActive(content, EXEC_PATH)).toBe(false);
    });

    it('Hidden=false 不影响判定（只有 =true 才是禁用）', () => {
      const content = [
        '[Desktop Entry]',
        `Exec=${expectedExec}`,
        'X-GNOME-Autostart-enabled=true',
        'Hidden=false',
        '',
      ].join('\n');
      expect(isLinuxEntryActive(content, EXEC_PATH)).toBe(true);
    });

    it('正常条目 → 启用，并给出判定依据', () => {
      const verdict = evaluateLinuxEntry(buildLinuxDesktopEntry(EXEC_PATH), EXEC_PATH);
      expect(verdict.active).toBe(true);
      expect(verdict.reason.length).toBeGreaterThan(0);
    });

    it('缺 Exec 行 → 未启用且原因明确', () => {
      const verdict = evaluateLinuxEntry('[Desktop Entry]\nType=Application\n', EXEC_PATH);
      expect(verdict.active).toBe(false);
      expect(verdict.reason).toContain('Exec');
    });
  });

  describe('日志（spec 28 §9A:232-233：自启变更必须落 main.log，修 P2-1）', () => {
    it('写入成功 → logger.info 记录请求值与写入后的真实状态', async () => {
      const { logger } = await import('../../utils/logger');
      const { adapter } = createFakeAdapter({ executableWillLaunchAtLogin: true });

      await setAutostartEnabled(createDeps('win32', adapter), true);

      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        expect.objectContaining({ platform: 'win32', requested: true }),
        expect.stringContaining('开机自启已变更'),
      );
    });

    it('写入抛错 → logger.error 记录后向上抛（不掩盖失败）', async () => {
      const { logger } = await import('../../utils/logger');
      const adapter: AutostartAdapter = {
        setLoginItemSettings: () => {
          throw new Error('registry denied');
        },
        getLoginItemSettings: () => ({ openAtLogin: false }),
      };

      await expect(setAutostartEnabled(createDeps('win32', adapter), true)).rejects.toThrow(
        'registry denied',
      );
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        expect.objectContaining({ platform: 'win32' }),
        expect.stringContaining('写入开机自启失败'),
      );
    });

    it('未打包（dev 守卫）→ 记 info 说明跳过原因，不静默', async () => {
      const { logger } = await import('../../utils/logger');
      const { adapter } = createFakeAdapter();

      const state = await setAutostartEnabled(
        createDeps('win32', adapter, { isPackaged: false }),
        true,
      );

      expect(state.supported).toBe(false);
      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        expect.objectContaining({ isPackaged: false }),
        expect.stringContaining('不支持'),
      );
    });
  });

  describe('resolveStartHidden（生产封装）', () => {
    it('argv 含 --hidden 时无须访问适配器即返回 true', () => {
      const original = process.argv;
      process.argv = [...original, AUTOSTART_HIDDEN_ARG];
      try {
        const { adapter, getCalls } = createFakeAdapter();
        expect(resolveStartHidden(adapter)).toBe(true);
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
