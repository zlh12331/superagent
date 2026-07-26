// e2e/electron.spec.ts
// Playwright Electron E2E 测试（方案 E）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 用 Playwright 的 Electron 测试能力，直接启动真实 Electron 应用
// - 验证 window.api 全链路 IPC 通信（preload 注入的真实 API，非 mock）
// - 验证 DOM 渲染完整性、React DevTools 扩展状态、Profiler 埋点
//
// 与 e2e/smoke.spec.ts（纯浏览器模式）的区别：
// - smoke.spec.ts：用浏览器访问 localhost:5173，无 preload，测纯前端 UI
// - electron.spec.ts：启动真实 Electron，有 preload + 主进程 + IPC 全链路
//
// 运行方式：
//   pnpm test:e2e:electron
//
// 策略：
// - 先用 electron-vite dev 启动 dev server（renderer + main + preload）
// - 然后用 _electron.launch 启动 Electron（连接到已运行的 dev server）
// - 这样能用 dev 模式（含 React DevTools、Profiler、HMR），而非生产构建
// ──────────────────────────────────────────────────────────────

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

// ESM 下 __dirname 替代方案
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Electron 主进程入口（electron-vite dev 构建产物，dev 模式）
const MAIN_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js');

// 启动 Electron 应用，返回 app 与首个 page
async function launchElectron(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      // 指定 renderer dev server URL，让主进程走 loadURL 而非 loadFile
      // electron-vite dev 默认端口 5173，被占用时递增到 5174
      ELECTRON_RENDERER_URL: 'http://localhost:5173',
    },
  });

  // 等待首个 BrowserWindow 的渲染层加载完成
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

test.describe('Electron 应用 E2E 测试', () => {
  let app: ElectronApplication;
  let page: Page;

  test.afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  test('应用启动并渲染主界面', async () => {
    ({ app, page } = await launchElectron());

    // 应用标题正确
    const title = await page.title();
    expect(title).toContain('网文写作 Agent');

    // root 节点有子元素（React 已渲染）
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
    // 验证关键域存在
    expect(apiKeys).toContain('app');
    expect(apiKeys).toContain('session');
    expect(apiKeys).toContain('system');
    expect(apiKeys).toContain('devtools');
    expect(apiKeys).toContain('agent');
    expect(apiKeys).toContain('file');
    expect(apiKeys).toContain('git');
    expect(apiKeys).toContain('codebase');
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

    const hookStatus = await page.evaluate(() => {
      return {
        hookExists: typeof window.__REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined',
        // renderers 是 Map<number, Renderer>
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

  test('RenderProfiler 埋点已启用', async () => {
    ({ app, page } = await launchElectron());

    // 等待 React 渲染完成后才有数据
    await page.waitForTimeout(1000);

    const profilerStatus = await page.evaluate(() => {
      if (typeof window.__RENDER_PROFILER__ === 'undefined') return null;
      return window.__RENDER_PROFILER__.stats();
    });

    expect(profilerStatus).not.toBeNull();
    expect(profilerStatus?.total).toBeGreaterThan(0);
    expect(profilerStatus?.mounts).toBeGreaterThan(0);
  });

  test('DevPanel 5 Tab 全部渲染', async () => {
    ({ app, page } = await launchElectron());

    // 等待应用渲染完成
    await page.waitForTimeout(1000);

    const tabTexts = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[role="tab"]')).map((t) =>
        t.textContent?.trim(),
      );
    });

    expect(tabTexts).toContain('终端');
    expect(tabTexts).toContain('Git');
    expect(tabTexts).toContain('日志');
    expect(tabTexts).toContain('指标');
    expect(tabTexts).toContain('检查器');
  });
});
