// e2e/electron-hidden-start.spec.ts：开机自启静默启动（--hidden 消费端）E2E —— 窗口须被创建
// 但不显示（仅驻留托盘），并锚两条回归不变量：P0-1 上次为最大化时 maximize() 不得击穿隐藏
//（Electron 的 maximize() 自身会显示窗口，src/main/window.ts 的 ready-to-show 分支对 --hidden
// 先早退）；P0-2 静默驻留后二次启动须把隐藏窗口唤到眼前（只 restore + focus 唤不出从未显示的
// 窗口，src/main/window-show.ts 显式 show）。
// 不锚：托盘图标实际渲染（无头环境不可靠）、macOS 的 wasOpenedAtLogin 分支（需真机，
// src/main/infra/autostart/autostart.test.ts 覆盖逻辑）。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

import { closeElectronApp } from './helpers/close-electron';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 启动装置：主进程入口取 e2e/playwright.electron.config.ts 的 webServer（electron-vite dev）
// 产出的 out/ 产物；渲染层经 ELECTRON_RENDERER_URL 从该 dev server 加载
const MAIN_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js');
/** 本 spec 专属 userData（经 CODE_AGENT_USER_DATA 注入）：种入的窗口状态不与其它 E2E 用例互相污染 */
const E2E_USER_DATA = join(__dirname, '..', '.e2e-user-data-hidden');
/** 种子路径须与主进程读取处一致（src/main/window.ts：join(userData, 'window-state.json')），否则种子无人消费 */
const WINDOW_STATE_FILE = join(E2E_USER_DATA, 'window-state.json');
/** CDP 调试端口：与 dev 实例默认 9222 及同批 spec 的 9223/9224 错开，避免端口冲突 */
const DEBUG_PORT = '9225';

/**
 * 预置窗口状态文件
 *
 * ⚠️ 必须在**每次启动前**重写：应用退出时会按实时状态回写该文件（trackWindowState 的
 * close 兜底），只种一次的话第二轮就变成 isMaximized:false，锚会静默退化。
 */
function seedWindowState(state: { readonly isMaximized: boolean }): void {
  mkdirSync(E2E_USER_DATA, { recursive: true });
  writeFileSync(
    WINDOW_STATE_FILE,
    JSON.stringify({ x: 213, y: 109, width: 1280, height: 802, ...state }),
    'utf8',
  );
}

/** 启动 Electron（extraArgs 追加到主进程入口之后） */
async function launchElectron(
  extraArgs: readonly string[],
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [MAIN_ENTRY, ...extraArgs],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      ELECTRON_RENDERER_URL: 'http://localhost:5173',
      CODE_AGENT_USER_DATA: E2E_USER_DATA,
      SENTRY_DSN: '',
      CODE_AGENT_DEBUG_PORT: DEBUG_PORT,
      // 豁免两项与本用例无关的行为：关窗协商（运行中回合的确认弹窗）与记忆引擎预热
      //（后者为保 E2E 启动耗时/CPU 稳定，见 src/main/infra/memory-hub/prewarm.ts）
      CODE_AGENT_SKIP_CLOSE_GUARD: '1',
      CODE_AGENT_SKIP_MEMORY_PREWARM: '1',
    },
  });
  const deadline = Date.now() + 20_000;
  let page: Page | undefined;
  while (Date.now() < deadline) {
    // 过滤 devtools:// 窗口：dev 模式可能先弹出 DevTools，拿它当主窗口会让后续断言失焦
    page = app.windows().find((w) => !w.url().startsWith('devtools://'));
    if (page !== undefined) {
      break;
    }
    // 每 2s 醒一次重扫：waitForEvent('window') 可能错过监听建立前已出现的窗口
    await Promise.race([
      app.waitForEvent('window'),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
  if (page === undefined) {
    await closeElectronApp(app);
    throw new Error('等待主窗口超时（20s）');
  }
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

/**
 * 读主窗口可见性
 *
 * 必须经主进程 BrowserWindow.isVisible()：窗口隐藏时页面照常运行，
 * DOM / document.visibilityState 分不出「隐藏窗口」与「正常显示」。
 */
async function isWindowVisible(app: ElectronApplication): Promise<boolean> {
  return await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return win?.isVisible() === true;
  });
}

/**
 * 启动一个「第二实例」（触发主实例的 second-instance 后立即退出）
 *
 * ⚠️ 不能用 Playwright 的 `_electron.launch`：第二实例拿不到单实例锁会立刻
 * `app.quit()`，launch 尚未建立连接目标就消失，抛 "Target page ... has been closed"
 * （2026-09-21 实测）。改用 execFile 跑仓库自带的 Electron 二进制（固定参数数组，
 * 不经 shell）——本用例只关心「主实例是否被唤起」，无需与第二实例建立 CDP 连接。
 */
async function spawnSecondInstance(): Promise<void> {
  const { execFile } = await import('node:child_process');
  const require = (await import('node:module')).createRequire(import.meta.url);
  // Node 下 require('electron') 返回可执行文件路径字符串（该包导出路径），不是模块对象
  const electronBinary = require('electron') as unknown as string;

  await new Promise<void>((resolve) => {
    execFile(
      electronBinary,
      [MAIN_ENTRY],
      {
        env: {
          ...process.env,
          NODE_ENV: 'development',
          ELECTRON_RENDERER_URL: 'http://localhost:5173',
          CODE_AGENT_USER_DATA: E2E_USER_DATA,
          SENTRY_DSN: '',
          // 换端口：主进程在拿单实例锁之前就已挂 remote-debugging-port（src/main/index.ts），
          // 与主实例同端口会争抢
          CODE_AGENT_DEBUG_PORT: '9235',
          CODE_AGENT_SKIP_CLOSE_GUARD: '1',
          CODE_AGENT_SKIP_MEMORY_PREWARM: '1',
        },
        timeout: 20_000,
        windowsHide: true,
      },
      // 拿不到单实例锁即 app.quit() 属正常路径：非 0 退出码/超时都属预期，回调里不区分
      () => {
        resolve();
      },
    );
  });
}

test.describe('开机自启静默启动（--hidden 消费端）', () => {
  let app: ElectronApplication;

  test.afterEach(async () => {
    if (app) {
      await closeElectronApp(app);
    }
    rmSync(WINDOW_STATE_FILE, { force: true });
  });

  test('带 --hidden：窗口创建但不显示（仅驻留托盘）', async () => {
    seedWindowState({ isMaximized: false });
    ({ app } = await launchElectron(['--hidden']));
    // 时序屏障：等过 ready-to-show（常规启动就在此时机显示窗口）再断言，
    // 立即断言会在窗口尚未走到显示时机时假绿
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(await isWindowVisible(app)).toBe(false);
    // 窗口必须存在：托盘与事件订阅都挂在窗口上，--hidden 只应压制显示、不能跳过创建
    const count = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    expect(count).toBeGreaterThan(0);
  });

  test('【P0-1 锚】上次为最大化 + --hidden：仍保持隐藏（不被 maximize 击穿）', async () => {
    seedWindowState({ isMaximized: true });
    ({ app } = await launchElectron(['--hidden']));
    // 同一时序屏障：等过 maximize()/show() 的时机
    await new Promise((resolve) => setTimeout(resolve, 3000));
    // 锚点：--hidden 未在 maximize 之前早退即失败——Electron 的 maximize() 自身会显示窗口
    expect(await isWindowVisible(app)).toBe(false);
  });

  test('不带 --hidden：窗口正常显示（回归锚，防静默启动逻辑误伤常规启动）', async () => {
    seedWindowState({ isMaximized: false });
    ({ app } = await launchElectron([]));
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(await isWindowVisible(app)).toBe(true);
  });

  test('不带 --hidden 且上次为最大化：窗口显示（防 P0-1 修复误伤常规启动）', async () => {
    seedWindowState({ isMaximized: true });
    ({ app } = await launchElectron([]));
    await new Promise((resolve) => setTimeout(resolve, 3000));
    // 反向锚：隐藏判定须只对 startHidden 生效，条件写反会让常规启动也不显示窗口
    expect(await isWindowVisible(app)).toBe(true);

    // 最大化态只在有真实窗口管理器的平台断言：Linux CI 走 xvfb（无 WM），isMaximized() 依赖
    // WM 的 EWMH 状态而恒为 false（2026-09-21 实测：ubuntu-latest / ubuntu-24.04-arm 稳定失败，
    // 同批 Windows / macOS 与本文件两个 P0 锚全绿），属断言过强而非实现缺陷
    if (process.platform === 'linux') {
      return;
    }
    const maximized = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win?.isMaximized() === true;
    });
    expect(maximized).toBe(true);
  });

  test('【P0-2 锚】静默驻留后再次启动：隐藏窗口被唤到眼前', async () => {
    seedWindowState({ isMaximized: false });
    ({ app } = await launchElectron(['--hidden']));
    await new Promise((resolve) => setTimeout(resolve, 3000));
    // 前置条件：二次启动前窗口确实处于隐藏态，否则后面的唤回断言无意义
    expect(await isWindowVisible(app)).toBe(false);

    await spawnSecondInstance();
    // 等第二实例拿不到单实例锁退出、主实例处理 second-instance 完成唤回
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // 锚点：未显示的窗口 restore（仅最小化时）+ focus 都唤不出来，必须显式 show()
    //（src/main/window-show.ts 的 showMainWindow）
    expect(await isWindowVisible(app)).toBe(true);
  });
});
