// e2e/electron.spec.ts：真实 Electron 实例的端到端用例——验证主窗口渲染、preload 注入的
// window.api 与 IPC 全链路（非 mock 桩）。浏览器模式的纯前端用例（window.api 由
// src/renderer/dev/mock-api.ts 模拟）不在此文件。
// 运行 pnpm test:e2e:electron：webServer 由 e2e/playwright.electron.config.ts 先拉起 electron-vite dev。

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

import { closeElectronApp } from './helpers/close-electron';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 主进程入口：electron-vite dev 的构建产物（webServer 先跑 electron-vite dev 才会生成）
const MAIN_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js');

// E2E 专属 userData：与 dev 实例（.electron-user-data）隔离，避免共用数据库/扩展目录互相干扰
const E2E_USER_DATA = join(__dirname, '..', '.e2e-user-data');
// 独立调试端口：dev 实例占用的是 9222（src/main/index.ts 的默认值），复用会连错调试目标
const DEBUG_PORT = '9223';

// 桌面视口：宽度必须大于 BREAKPOINT_COMPACT（1200px，src/renderer/lib/constants.ts），
// 否则右面板自动折叠、DevPanel 不挂载，「右面板默认视图」用例必失败（CI 虚拟屏可能更窄）
const DESKTOP_VIEWPORT = { width: 1600, height: 1000 };

// ───── 启动辅助：等出非 DevTools 的主窗口 + 带 E2E 环境变量的冷启动 ─────

/**
 * 等待主窗口（过滤 devtools:// 窗口）
 *
 * dev 模式可能先弹出 DevTools 窗口（或 devtools/open 用例的遗留窗口），
 * app.firstWindow() 会拿到 devtools:// 目标导致后续断言全部失焦；
 * 循环等待直到出现非 DevTools 窗口（2026-08-27 实测暴露，与 perf-electron 同构）。
 */
async function waitForMainWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const existing = app.windows().find((w) => !w.url().startsWith('devtools://'));
    if (existing !== undefined) {
      return existing;
    }
    await Promise.race([
      app.waitForEvent('window'),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
  throw new Error('等待主窗口超时（20s）：仅出现 DevTools 窗口');
}

async function launchElectron(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      // 设了它就改走 loadURL 连 dev server，而非 loadFile 载生产产物（src/main/window.ts）；
      // 端口须与 e2e/playwright.electron.config.ts 的 webServer 一致
      ELECTRON_RENDERER_URL: 'http://localhost:5173',
      CODE_AGENT_USER_DATA: E2E_USER_DATA,
      SENTRY_DSN: '',
      CODE_AGENT_DEBUG_PORT: DEBUG_PORT,
      // 豁免关窗协商：仍有运行中回合时关闭会弹确认框（src/main/window.ts），测试环境会卡死
      CODE_AGENT_SKIP_CLOSE_GUARD: '1',
      // 跳过记忆引擎预热：其子进程 CPU 密集且会干扰启动耗时断言与其他用例的时序，
      // 而 E2E 并不验证记忆功能（另有单测覆盖）
      CODE_AGENT_SKIP_MEMORY_PREWARM: '1',
    },
  });

  try {
    const page = await waitForMainWindow(app);
    await page.waitForLoadState('domcontentloaded');
    await page.setViewportSize(DESKTOP_VIEWPORT);
    return { app, page };
  } catch (err) {
    // 启动半途失败也必须回收已拉起的实例，否则残留进程会拖到 worker teardown 超时
    await closeElectronApp(app);
    throw err;
  }
}

test.describe('Electron 应用 E2E 测试', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(() => {
    // 预置 React DevTools 扩展：electron-devtools-installer 首装需从 Chrome 商店下载，
    // 受限网络环境会失败；从 dev 实例的 userData 复制已装扩展，离线也能加载
    const REACT_DEVTOOLS_ID = 'fmkadmapgofadopljbjfkapdkoienihi';
    const src = join(__dirname, '..', '.electron-user-data', 'extensions', REACT_DEVTOOLS_ID);
    const dstDir = join(E2E_USER_DATA, 'extensions');
    const dst = join(dstDir, REACT_DEVTOOLS_ID);
    if (existsSync(src) && !existsSync(dst)) {
      mkdirSync(dstDir, { recursive: true });
      cpSync(src, dst, { recursive: true });
    }
  });

  test.afterEach(async () => {
    if (app) {
      // e2e/helpers/close-electron.ts 内是「优雅关闭 + 超时强杀」兜底，防 app.close() 挂起
      await closeElectronApp(app);
    }
  });

  test('应用启动并渲染主界面', async () => {
    ({ app, page } = await launchElectron());

    const title = await page.title();
    expect(title).toContain('Code Agent Desktop');

    const rootChildCount = await page.evaluate(() => {
      const root = document.getElementById('root');
      return root?.childElementCount ?? 0;
    });
    expect(rootChildCount).toBeGreaterThan(0);
  });

  test('window.api 全部域已注入', async () => {
    ({ app, page } = await launchElectron());

    const apiKeys = await page.evaluate(() => {
      if (typeof window.api === 'undefined') return null;
      return Object.keys(window.api);
    });

    expect(apiKeys).not.toBeNull();
    expect(apiKeys).toContain('app');
    expect(apiKeys).toContain('session');
    expect(apiKeys).toContain('system');
    expect(apiKeys).toContain('devtools');
    expect(apiKeys).toContain('agent');
    expect(apiKeys).toContain('file');
    expect(apiKeys).toContain('git');
    expect(apiKeys).toContain('terminal');
    expect(apiKeys).toContain('tool');
    expect(apiKeys).toContain('settings');
  });

  test('IPC 全链路：session/list 返回会话列表', async () => {
    ({ app, page } = await launchElectron());

    const result = await page.evaluate(async () => {
      const res = await window.api.session.list({ limit: 50, offset: 0 });
      return {
        hasError: 'error' in res,
        hasData: 'data' in res,
        dataKeys: 'data' in res ? Object.keys(res.data) : null,
      };
    });

    expect(result.hasError).toBe(false);
    expect(result.hasData).toBe(true);
  });

  test('IPC 全链路：system/getStatus 返回运行时状态', async () => {
    ({ app, page } = await launchElectron());

    const result = await page.evaluate(async () => {
      const res = await window.api.system.getStatus();
      return {
        hasError: 'error' in res,
        hasData: 'data' in res,
        dataKeys: 'data' in res ? Object.keys(res.data) : null,
      };
    });

    expect(result.hasError).toBe(false);
    expect(result.hasData).toBe(true);
  });

  test('IPC 全链路：devtools/open 打开 DevTools', async () => {
    ({ app, page } = await launchElectron());

    const result = await page.evaluate(async () => {
      const res = await window.api.devtools.open({ mode: 'detach' });
      return {
        hasError: 'error' in res,
        hasData: 'data' in res,
        ok: 'data' in res ? (res.data as { ok?: boolean }).ok : null,
      };
    });

    expect(result.hasError).toBe(false);
    expect(result.ok).toBe(true);
  });

  test('React DevTools 扩展 hook 已注入', async () => {
    ({ app, page } = await launchElectron());

    // 扩展在 React 挂载后才注册 renderer，立即断言会过早失败，故轮询等待；
    // 扩展未加载（受限网络环境装不上）时显式跳过，环境问题不算应用缺陷
    let ready = true;
    try {
      await page.waitForFunction(
        () =>
          typeof window.__REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined' &&
          typeof window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers !== 'undefined' &&
          window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.size > 0,
        undefined,
        { timeout: 30_000 },
      );
    } catch {
      ready = false;
    }
    test.skip(!ready, 'React DevTools 扩展未加载（受限网络环境无法安装），跳过本用例');

    const hookStatus = await page.evaluate(() => {
      return {
        hookExists: typeof window.__REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined',
        rendererCount:
          typeof window.__REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined' &&
          window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers
            ? window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.size
            : 0,
      };
    });

    expect(hookStatus.hookExists).toBe(true);
    expect(hookStatus.rendererCount).toBeGreaterThan(0);
  });

  test('右面板默认视图 + 添加视图交互', async () => {
    ({ app, page } = await launchElectron());

    // DevPanel 初始只常驻「会话详情」，终端/文件变更/文件/浏览器/开发者视图要靠「添加视图」加入
    const defaultTab = page.getByRole('tab', { name: /会话详情|Info/ });
    await expect(defaultTab).toBeVisible({ timeout: 30_000 });

    const addView = page.getByRole('button', { name: /添加视图|Add view/ });
    await expect(addView).toBeVisible();

    await addView.click();
    const terminalItem = page.getByRole('menuitem', { name: /终端|Terminal/ });
    await expect(terminalItem).toBeVisible({ timeout: 10_000 });
    await terminalItem.click();
    const terminalTab = page
      .getByRole('tab', { name: '终端', exact: true })
      .or(page.getByRole('tab', { name: 'Terminal', exact: true }));
    await expect(terminalTab.first()).toBeVisible({ timeout: 15_000 });
  });
});
