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
          CODE_AGENT_DEBUG_PORT: '9235',
          CODE_AGENT_SKIP_CLOSE_GUARD: '1',
          CODE_AGENT_SKIP_MEMORY_PREWARM: '1',
        },
        timeout: 20_000,
        windowsHide: true,
      },
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
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(await isWindowVisible(app)).toBe(false);
    const count = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    expect(count).toBeGreaterThan(0);
  });

  test('【P0-1 锚】上次为最大化 + --hidden：仍保持隐藏（不被 maximize 击穿）', async () => {
    seedWindowState({ isMaximized: true });
    ({ app } = await launchElectron(['--hidden']));
    await new Promise((resolve) => setTimeout(resolve, 3000));
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
    expect(await isWindowVisible(app)).toBe(true);

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
    expect(await isWindowVisible(app)).toBe(false);

    await spawnSecondInstance();
    await new Promise((resolve) => setTimeout(resolve, 3000));

    expect(await isWindowVisible(app)).toBe(true);
  });
});
