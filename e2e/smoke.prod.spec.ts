import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

const PRODUCT_NAME = 'Code Agent Desktop';
const LINUX_EXECUTABLE = 'code-agent-desktop';

/** 当前架构对应的 unpacked 目录后缀（x64 为默认架构，无后缀） */
const ARCH_SUFFIX = process.arch === 'arm64' ? '-arm64' : '';

/** 按候选顺序找到第一个存在的路径 */
function firstExisting(candidates: readonly string[]): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? '';
}

function resolvePackagedExecutable(): string {
  const releaseDir = join(process.cwd(), 'release');
  if (process.platform === 'win32') {
    return firstExisting(
      [`win${ARCH_SUFFIX}-unpacked`, 'win-unpacked'].map((dir) =>
        join(releaseDir, dir, `${PRODUCT_NAME}.exe`),
      ),
    );
  }
  if (process.platform === 'linux') {
    return firstExisting(
      [`linux${ARCH_SUFFIX}-unpacked`, 'linux-unpacked'].map((dir) =>
        join(releaseDir, dir, LINUX_EXECUTABLE),
      ),
    );
  }
  const preferred =
    process.arch === 'arm64' ? ['mac-arm64', 'mac'] : ['mac', 'mac-arm64', 'mac-x64'];
  return firstExisting(
    preferred.map((dirName) =>
      join(releaseDir, dirName, `${PRODUCT_NAME}.app`, 'Contents', 'MacOS', PRODUCT_NAME),
    ),
  );
}

const EXECUTABLE_PATH = resolvePackagedExecutable();

async function launchPackagedApp(): Promise<{ app: ElectronApplication; page: Page }> {
  if (!existsSync(EXECUTABLE_PATH)) {
    throw new Error(`可执行文件不存在：${EXECUTABLE_PATH}\n请先执行 pnpm build:dist 生成打包产物`);
  }

  const app = await electron.launch({
    executablePath: EXECUTABLE_PATH,
    env: {
      ...process.env,
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

    const title = await page.title();
    expect(title).toContain('Code Agent Desktop');

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
    expect(apiKeys).toContain('app');
    expect(apiKeys).toContain('session');
    expect(apiKeys).toContain('system');
    expect(apiKeys).toContain('agent');
    expect(apiKeys).toContain('file');
    expect(apiKeys).toContain('git');
    expect(apiKeys).toContain('models');
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
    expect(result.isPackaged).toBe(true);
  });

  test('生产构建启动到可交互 < 10s（分段报告）', async () => {
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
    const t1 = Date.now();

    const page = await launchApp.firstWindow();
    const t2 = Date.now();

    await page.waitForLoadState('domcontentloaded');
    const t3 = Date.now();

    const input = page.locator('textarea').first();
    await expect(input).toBeVisible({ timeout: 15_000 });
    const t4 = Date.now();

    await input.fill('');
    const t5 = Date.now();

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

    await page.waitForTimeout(2000);

    const criticalErrors = errors.filter(
      (e) =>
        !e.includes('DevTools') &&
        !e.includes('Download the React DevTools') &&
        !e.includes('Content Security Policy'),
    );

    expect(criticalErrors).toEqual([]);
  });
});
