// e2e/smoke.prod.spec.ts
// 生产构建冒烟测试
// ──────────────────────────────────────────────────────────────
// 职责：
// - 针对 electron-builder 打包后的 win-unpacked 可执行文件运行测试
// - 验证生产构建（app.isPackaged === true）的真实运行情况
// - 覆盖：应用启动、窗口渲染、preload 注入、IPC 全链路、SQLite 持久化
//
// 与 electron.spec.ts（dev 模式）的区别：
// - 不验证 React DevTools（生产环境不安装）
// - 不验证 RenderProfiler 埋点（生产环境透传，不收集）
// - 聚焦：窗口可打开、IPC 可通、SQLite 可读写
//
// 运行方式：
//   pnpm build:dist && pnpm test:smoke
// ──────────────────────────────────────────────────────────────

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

// win-unpacked 可执行文件路径
// electron-builder 打包后输出到 release/win-unpacked/<productName>.exe
const PRODUCT_NAME = 'Code Agent Desktop';
const EXECUTABLE_PATH = join(process.cwd(), 'release', 'win-unpacked', `${PRODUCT_NAME}.exe`);

// 启动打包后的 Electron 应用
async function launchPackagedApp(): Promise<{ app: ElectronApplication; page: Page }> {
  // 前置检查：可执行文件必须存在
  if (!existsSync(EXECUTABLE_PATH)) {
    throw new Error(`可执行文件不存在：${EXECUTABLE_PATH}\n请先执行 pnpm build:dist 生成打包产物`);
  }

  const app = await electron.launch({
    executablePath: EXECUTABLE_PATH,
    // 生产环境不需要 ELECTRON_RENDERER_URL，应用会 loadFile 加载本地 renderer
    env: {
      ...process.env,
      // 生产模式：确保不进入 dev 逻辑
      NODE_ENV: 'production',
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

test.describe('生产构建冒烟测试', () => {
  let app: ElectronApplication;
  let page: Page;

  test.afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  test('应用启动并渲染主界面', async () => {
    ({ app, page } = await launchPackagedApp());

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

  test('window.api 全部域已注入（preload 正常加载）', async () => {
    ({ app, page } = await launchPackagedApp());

    const apiKeys = await page.evaluate(() => {
      if (typeof window.api === 'undefined') return null;
      return Object.keys(window.api);
    });

    expect(apiKeys).not.toBeNull();
    // 验证关键域存在（preload 正常注入）
    expect(apiKeys).toContain('app');
    expect(apiKeys).toContain('session');
    expect(apiKeys).toContain('system');
    expect(apiKeys).toContain('agent');
    expect(apiKeys).toContain('file');
    expect(apiKeys).toContain('git');
    expect(apiKeys).toContain('codebase');
    expect(apiKeys).toContain('tool');
    expect(apiKeys).toContain('settings');
  });

  test('IPC 全链路：session/list 返回会话列表（SQLite 初始化成功）', async () => {
    ({ app, page } = await launchPackagedApp());

    const result = await page.evaluate(async () => {
      const res = await window.api.session.list({ limit: 50, offset: 0 });
      return {
        hasError: 'error' in res,
        hasData: 'data' in res,
      };
    });

    // SQLite 初始化成功才能返回数据
    expect(result.hasError).toBe(false);
    expect(result.hasData).toBe(true);
  });

  test('IPC 全链路：system/getStatus 返回运行时状态', async () => {
    ({ app, page } = await launchPackagedApp());

    const result = await page.evaluate(async () => {
      const res = await window.api.system.getStatus();
      return {
        hasError: 'error' in res,
        hasData: 'data' in res,
        isPackaged: 'data' in res ? (res.data as { isPackaged?: boolean }).isPackaged : null,
      };
    });

    expect(result.hasError).toBe(false);
    expect(result.hasData).toBe(true);
    // 生产构建必须返回 isPackaged === true
    expect(result.isPackaged).toBe(true);
  });

  test('生产构建启动到可交互 < 10s（分段报告）', async () => {
    // 前置检查（与 launchPackagedApp 一致，但需分段计时故独立实现）
    if (!existsSync(EXECUTABLE_PATH)) {
      throw new Error(
        `可执行文件不存在：${EXECUTABLE_PATH}\n请先执行 pnpm build:dist 生成打包产物`,
      );
    }

    const t0 = Date.now();
    const launchApp = await electron.launch({
      executablePath: EXECUTABLE_PATH,
      env: { ...process.env, NODE_ENV: 'production' },
    });
    const t1 = Date.now(); // 进程启动 + 首窗口创建

    const page = await launchApp.firstWindow();
    const t2 = Date.now(); // 首窗口可用

    await page.waitForLoadState('domcontentloaded');
    const t3 = Date.now(); // DOM 加载完成

    // UI 就绪：输入框可见（React 挂载完成——生产首页无品牌文本，textarea 是最稳标志）
    const input = page.locator('textarea').first();
    await expect(input).toBeVisible({ timeout: 15_000 });
    const t4 = Date.now(); // React 首屏渲染完成

    // 可交互：输入框可聚焦（真实键盘事件可写入）
    await input.fill('');
    const t5 = Date.now(); // 可交互

    const total = t5 - t0;
    console.log(
      `[perf:startup] 生产启动分段：launch ${t1 - t0}ms / firstWindow ${t2 - t1}ms / dom ${t3 - t2}ms / React 首屏 ${t4 - t3}ms / 可交互 ${t5 - t4}ms / 合计 ${total}ms`,
    );
    expect(total, '生产构建冷启动到可交互应 < 10s（基线，渐进收紧）').toBeLessThan(10_000);

    await launchApp.close();
  });

  test('应用无控制台错误', async () => {
    ({ app, page } = await launchPackagedApp());

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      errors.push(err.message);
    });

    // 等待应用完全渲染
    await page.waitForTimeout(2000);

    // 过滤已知的非阻塞警告（如 CSP 警告、DevTools 提示）
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes('DevTools') &&
        !e.includes('Download the React DevTools') &&
        !e.includes('Content Security Policy'),
    );

    expect(criticalErrors).toEqual([]);
  });
});
