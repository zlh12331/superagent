import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

import { closeElectronApp } from './helpers/close-electron';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MAIN_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js');

const E2E_USER_DATA = join(__dirname, '..', '.e2e-user-data-update');
const DEBUG_PORT = '9224';

/** 启动检查延迟（主进程 LAUNCH_CHECK_DELAY_MS = 5s） */
const LAUNCH_CHECK_DELAY_MS = 5_000;

const DONE_PHASES = new Set(['not-available', 'error', 'downloaded', 'cancelled']);

/**
 * 等待主窗口（过滤 devtools:// 窗口）
 *
 * dev 模式可能先弹 DevTools 窗口，firstWindow() 会拿到 devtools:// 目标
 * 导致后续断言失焦（与 electron.spec.ts waitForMainWindow 同构）。
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

/** 启动 Electron 测试实例（extraEnv 显式覆盖，防止本机环境变量意外透传） */
async function launchElectron(
  extraEnv: Record<string, string>,
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      ELECTRON_RENDERER_URL: 'http://localhost:5173',
      CODE_AGENT_USER_DATA: E2E_USER_DATA,
      SENTRY_DSN: '',
      CODE_AGENT_DEBUG_PORT: DEBUG_PORT,
      CODE_AGENT_SKIP_CLOSE_GUARD: '1',
      CODE_AGENT_SKIP_MEMORY_PREWARM: '1',
      ...extraEnv,
    },
  });

  try {
    const page = await waitForMainWindow(app);
    await page.waitForLoadState('domcontentloaded');
    return { app, page };
  } catch (err) {
    await closeElectronApp(app);
    throw err;
  }
}

/** 读主进程更新状态快照（IPC 层错误直接抛出使用例失败） */
function readStatus(page: Page): Promise<{
  snapshot: { phase: string; message?: string } | null;
  lastCheckAt: number | null;
}> {
  return page.evaluate(async () => {
    const r = await window.api.update.getStatus();
    if (!('data' in r)) {
      throw new Error('update:getStatus IPC 层失败');
    }
    return r.data;
  });
}

test.describe('dev 更新调试链路（CODE_AGENT_DEV_UPDATE 接线）', () => {
  let app: ElectronApplication;
  let page: Page;

  test.afterEach(async () => {
    if (app) {
      await closeElectronApp(app);
    }
  });

  test('无开关：dev 门卫拦截手动检查，启动检查不发生', async () => {
    ({ app, page } = await launchElectron({ CODE_AGENT_DEV_UPDATE: '' }));

    const res = await page.evaluate(async () => {
      const r = await window.api.update.check({ manual: true });
      if (!('data' in r)) {
        throw new Error('update:check IPC 层失败');
      }
      return r.data;
    });
    expect(res.status).toBe('error');
    expect(res.message ?? '').toContain('开发模式不支持');

    const status = await readStatus(page);
    expect(status.lastCheckAt).toBeNull();
    expect(status.snapshot?.phase).toBe('error');

    await page.waitForTimeout(LAUNCH_CHECK_DELAY_MS + 1_500);
    const settled = await readStatus(page);
    expect(settled.lastCheckAt).toBeNull();
  });

  test('开关开启：启动检查真实发生并推送渲染层', async () => {
    test.setTimeout(120_000);
    ({ app, page } = await launchElectron({ CODE_AGENT_DEV_UPDATE: '1' }));

    const deadline = Date.now() + 75_000;
    let phase: string | undefined;
    let lastCheckAt: number | null = null;
    let message = '';
    while (Date.now() < deadline) {
      const status = await readStatus(page);
      lastCheckAt = status.lastCheckAt;
      phase = status.snapshot?.phase;
      message = status.snapshot?.message ?? '';
      if (phase !== undefined && phase !== 'checking') {
        if (DONE_PHASES.has(phase)) {
          break;
        }
        await page.evaluate(() => window.api.update.cancel());
      }
      await page.waitForTimeout(1_000);
    }

    expect(lastCheckAt).not.toBeNull();
    expect(phase).not.toBeUndefined();
    expect(phase).not.toBe('checking');
    expect(message).not.toContain('开发模式不支持');
  });
});
