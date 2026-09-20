// e2e/electron-hidden-start.spec.ts
// 开机自启静默启动 E2E（--hidden 参数消费端验证）
// ──────────────────────────────────────────────────────────────
// 锚什么：带 --hidden 启动时窗口创建但不显示（仅驻留托盘）——这是 2026-09-20 修复
// 的缺陷：此前该参数只有写入端、无消费端（"实现必需，此前遗漏"），开机自启照常弹窗。
// 不锚什么：托盘图标实际渲染（无头环境不可靠）；macOS 的 wasOpenedAtLogin 分支
// （需 macOS 真机，由单测覆盖逻辑）。
// ──────────────────────────────────────────────────────────────

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
const DEBUG_PORT = '9225';

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

test.describe('开机自启静默启动（--hidden 消费端）', () => {
  let app: ElectronApplication;

  test.afterEach(async () => {
    if (app) {
      await closeElectronApp(app);
    }
  });

  test('带 --hidden：窗口创建但不显示（仅驻留托盘）', async () => {
    ({ app } = await launchElectron(['--hidden']));
    // 等过 ready-to-show 的常规显示窗口时机，再断言仍不可见
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(await isWindowVisible(app)).toBe(false);
    // 窗口确实存在（托盘/事件订阅依赖它，不能被跳过创建）
    const count = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    expect(count).toBeGreaterThan(0);
  });

  test('不带 --hidden：窗口正常显示（回归锚，防静默启动逻辑误伤常规启动）', async () => {
    ({ app } = await launchElectron([]));
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(await isWindowVisible(app)).toBe(true);
  });
});
