// e2e/electron-hidden-start.spec.ts
// 开机自启静默启动 E2E（--hidden 参数消费端验证 + 两个 2026-09-21 修复的回归锚）
// ──────────────────────────────────────────────────────────────
// 锚什么：
// 1. 带 --hidden 启动时窗口创建但不显示（仅驻留托盘）——2026-09-20 修复的缺陷：
//    此前该参数只有写入端、无消费端，开机自启照常弹窗。
// 2. 【P0-1 回归锚】上次窗口为最大化时，--hidden 仍须保持隐藏 —— 此前 window.ts 在
//    ready-to-show 之外无条件调用 maximize()，而 Electron 的 maximize() 自身会显示
//    窗口（electron.d.ts:3101），于是"上次最大化过"的用户开机必然弹窗。
// 3. 【P0-2 回归锚】静默驻留后再次启动应用，须把隐藏窗口唤到眼前 —— 此前
//    second-instance 只做 restore(仅最小化时)+focus，隐藏窗口既不可见也未最小化，
//    focus() 不会让它出现（用户表现为"点了没反应"）。
// 不锚什么：托盘图标实际渲染（无头环境不可靠）；macOS 的 wasOpenedAtLogin 分支
// （需 macOS 真机，由单测覆盖逻辑）。
// ──────────────────────────────────────────────────────────────

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

import { closeElectronApp } from './helpers/close-electron';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MAIN_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js');
const E2E_USER_DATA = join(__dirname, '..', '.e2e-user-data-hidden');
const WINDOW_STATE_FILE = join(E2E_USER_DATA, 'window-state.json');
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
      CODE_AGENT_SKIP_CLOSE_GUARD: '1',
      CODE_AGENT_SKIP_MEMORY_PREWARM: '1',
    },
  });
  const deadline = Date.now() + 20_000;
  let page: Page | undefined;
  while (Date.now() < deadline) {
    page = app.windows().find((w) => !w.url().startsWith('devtools://'));
    if (page !== undefined) {
      break;
    }
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

/** 读主窗口可见性（经 Electron 主进程 API，非 DOM 判断） */
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
  // require('electron') 在 Node 下返回可执行文件路径（该包导出路径字符串）
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
          CODE_AGENT_DEBUG_PORT: '9235', // 换端口，避免与主实例争抢
          CODE_AGENT_SKIP_CLOSE_GUARD: '1',
          CODE_AGENT_SKIP_MEMORY_PREWARM: '1',
        },
        timeout: 20_000,
        windowsHide: true,
      },
      // 正常路径：拿不到单实例锁 → app.quit()；非 0 退出码/超时都属预期，无需区分
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
    // 清掉预置的窗口状态：避免残留影响其它用例与下次运行
    rmSync(WINDOW_STATE_FILE, { force: true });
  });

  test('带 --hidden：窗口创建但不显示（仅驻留托盘）', async () => {
    seedWindowState({ isMaximized: false });
    ({ app } = await launchElectron(['--hidden']));
    // 等过 ready-to-show 的常规显示窗口时机，再断言仍不可见
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(await isWindowVisible(app)).toBe(false);
    // 窗口确实存在（托盘/事件订阅依赖它，不能被跳过创建）
    const count = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    expect(count).toBeGreaterThan(0);
  });

  test('【P0-1 锚】上次为最大化 + --hidden：仍保持隐藏（不被 maximize 击穿）', async () => {
    seedWindowState({ isMaximized: true });
    ({ app } = await launchElectron(['--hidden']));
    await new Promise((resolve) => setTimeout(resolve, 3000));
    // 修复前：window.ts 无条件 maximize() ⇒ 窗口被显示，此断言失败
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
    // 核心断言：窗口必须显示（P0-1 的修复把 maximize 移进 ready-to-show，
    // 若写错会让常规启动也不显示窗口——本断言就是防这个）
    expect(await isWindowVisible(app)).toBe(true);

    // 最大化态只在有真实窗口管理器的平台断言：Linux CI 走 xvfb（无 WM），
    // isMaximized() 依赖 WM 的 EWMH 状态，在无 WM 下恒为 false
    // （2026-09-21 实测：ubuntu-latest / ubuntu-24.04-arm 上此断言稳定失败，
    // 而同批次的 Windows / macOS 与两个 P0 锚全绿）。这是断言过强而非实现缺陷。
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
    expect(await isWindowVisible(app)).toBe(false); // 前提：确实隐藏着

    await spawnSecondInstance();
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // 修复前：second-instance 只 restore(仅最小化时)+focus ⇒ 隐藏窗口唤不出，此断言失败
    expect(await isWindowVisible(app)).toBe(true);
  });
});
