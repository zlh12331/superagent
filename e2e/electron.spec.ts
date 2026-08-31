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

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

import { closeElectronApp } from './helpers/close-electron';

// ESM 下 __dirname 替代方案
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Electron 主进程入口（electron-vite dev 构建产物，dev 模式）
const MAIN_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js');

// E2E 专用 userData 目录（与 dev 实例隔离，避免 SQLite 锁/扩展目录冲突）
const E2E_USER_DATA = join(__dirname, '..', '.e2e-user-data');
// 测试实例独立调试端口（避免与 dev 实例的 9222 冲突导致 CDP 连不上、launch 超时）
const DEBUG_PORT = '9223';

// 桌面布局视口：宽度需 > 右面板折叠断点（1200px，见 use-layout-breakpoint）
const DESKTOP_VIEWPORT = { width: 1600, height: 1000 };

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
      // 独立 userData：避免与 dev 实例（.electron-user-data）冲突
      CODE_AGENT_USER_DATA: E2E_USER_DATA,
      // S16：本地 E2E 会话错误不报 Sentry（...process.env 会透传本地 .env 的 DSN）
      SENTRY_DSN: '',
      // 独立调试端口：dev 实例（electron-vite dev 自带窗口）已占 9222
      CODE_AGENT_DEBUG_PORT: DEBUG_PORT,
    },
  });

  try {
    // 等待主窗口（非 devtools://）加载完成；首窗口可能是 DevTools，需过滤
    const page = await waitForMainWindow(app);
    await page.waitForLoadState('domcontentloaded');
    // 固定为桌面视口：CI runner 虚拟屏窄于 1200px 断点时右面板会自动折叠、DevPanel 不挂载
    await page.setViewportSize(DESKTOP_VIEWPORT);
    return { app, page };
  } catch (err) {
    // 启动半途失败必须回收已拉起的实例，否则残留进程导致 worker teardown 超时
    await closeElectronApp(app);
    throw err;
  }
}

test.describe('Electron 应用 E2E 测试', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(() => {
    // 预置 React DevTools 扩展：electron-devtools-installer 首装需从 Chrome 商店
    // 下载，受限网络环境会失败；从 dev 实例 userData 复制已有扩展保证离线可加载。
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
      // 优雅关闭 + 超时强杀兜底（防 app.close() 挂起触发 teardown 超时）
      await closeElectronApp(app);
    }
  });

  test('应用启动并渲染主界面', async () => {
    ({ app, page } = await launchElectron());

    // 应用标题正确
    const title = await page.title();
    expect(title).toContain('Code Agent Desktop');

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
    // codebase 域已移除（4824e3f：改为 Agent 工具），改校验 terminal 域
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

    // 轮询等待 React 挂载后 DevTools 注册 renderer（立即评估会早于挂载完成）；
    // 扩展首装依赖网络下载，受限环境可能未加载 → 无法就绪时显式跳过（对齐
    // memory-leak.spec.ts 的环境依赖跳过惯例），不误报为应用缺陷。
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

  // 注：原 'RenderProfiler 埋点已启用' 用例已移除（2026-08-27 审计）：
  // __RENDER_PROFILER__ 实现已在 e6dc26e（knip 死代码清理）中删除，测试残留。

  test('右面板默认视图 + 添加视图交互', async () => {
    ({ app, page } = await launchElectron());

    // DevPanel 改版后的行为（与 DevPanel 单测同构）：默认仅会话详情常驻，
    // 其余视图（终端/文件变更/文件/浏览器/开发者）通过“添加视图”按需加入。
    // 旧断言（首屏 6 tab 全渲染）与新交互不符，2026-08-27 实测纠正。
    const defaultTab = page.getByRole('tab', { name: /会话详情|Info/ });
    await expect(defaultTab).toBeVisible({ timeout: 30_000 });

    const addView = page.getByRole('button', { name: /添加视图|Add view/ });
    await expect(addView).toBeVisible();

    // 添加终端视图 → 新 tab 出现
    await addView.click();
    const terminalItem = page.getByRole('menuitem', { name: /终端|Terminal/ });
    await expect(terminalItem).toBeVisible({ timeout: 10_000 });
    await terminalItem.click();
    // 精确匹配 DevPanel 的终端 tab：TerminalPanel 内部 tab 栏的“bash 关闭终端”
    // 也带 role=tab，宽正则会误匹配（2026-08-27 实测暴露）
    const terminalTab = page
      .getByRole('tab', { name: '终端', exact: true })
      .or(page.getByRole('tab', { name: 'Terminal', exact: true }));
    await expect(terminalTab.first()).toBeVisible({ timeout: 15_000 });
  });
});
