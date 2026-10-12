// e2e/electron-update-dev.spec.ts：dev 更新调试链路 E2E（CODE_AGENT_DEV_UPDATE 接线验证）
// 无开关：门卫拒绝手动检查（「开发模式不支持」），启动检查也不发生（lastCheckAt 恒 null）。
// 开关开启：启动检查（延迟 5s）真发、状态经 IPC 推送渲染层；断言只要求到达任意终态
// （结果依赖网络），不覆盖 electron-updater 自身行为。
// 副作用防护：远端版本更高时会开始真实下载（Windows 全量约 328MB，见 dev-app-update.yml），
// 用例检测到 available/downloading 立即 cancel。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

import { closeElectronApp } from './helpers/close-electron';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// electron-vite 产物主进程入口（playwright.electron.config.ts 的 webServer 先跑 electron-vite dev）
const MAIN_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js');

// 本 spec 专用 userData：与其他 e2e/dev 实例隔离，避免 SQLite 锁竞争
const E2E_USER_DATA = join(__dirname, '..', '.e2e-user-data-update');
// 独立调试端口：9222 归 dev 实例、9223 归 electron.spec.ts——撞端口会让 CDP 连不上、launch 超时
const DEBUG_PORT = '9224';

/** 启动检查延迟（主进程 LAUNCH_CHECK_DELAY_MS = 5s） */
const LAUNCH_CHECK_DELAY_MS = 5_000;

// 检查链路终态：网络错误同样算链路已通；available/downloading 是下载中态，由用例 cancel 后转 cancelled
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
      // renderer dev server（playwright.electron.config.ts 的 webServer 起在 5173）
      ELECTRON_RENDERER_URL: 'http://localhost:5173',
      CODE_AGENT_USER_DATA: E2E_USER_DATA,
      SENTRY_DSN: '',
      CODE_AGENT_DEBUG_PORT: DEBUG_PORT,
      // 关窗协商豁免：无头 E2E 跳过退出确认模态框
      CODE_AGENT_SKIP_CLOSE_GUARD: '1',
      // 记忆引擎预热豁免：预热 CPU 密集、耗时长，会干扰启动时序（本 spec 不测记忆）
      CODE_AGENT_SKIP_MEMORY_PREWARM: '1',
      ...extraEnv,
    },
  });

  try {
    const page = await waitForMainWindow(app);
    await page.waitForLoadState('domcontentloaded');
    return { app, page };
  } catch (err) {
    // 启动半途失败必须回收实例：残留进程会让 worker teardown 超时
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
      // 走 helper 关闭（优雅 → 超时强杀兜底）：app.close() 挂起会触发 teardown 超时
      await closeElectronApp(app);
    }
  });

  test('无开关：dev 门卫拦截手动检查，启动检查不发生', async () => {
    ({ app, page } = await launchElectron({ CODE_AGENT_DEV_UPDATE: '' }));

    // 门卫拒绝手动检查：返回结构化错误（非 IPC 异常）
    const res = await page.evaluate(async () => {
      const r = await window.api.update.check({ manual: true });
      if (!('data' in r)) {
        throw new Error('update:check IPC 层失败');
      }
      return r.data;
    });
    expect(res.status).toBe('error');
    expect(res.message ?? '').toContain('开发模式不支持');

    // 门卫先于 lastCheckAt 置位；manual=true 的错误快照已推送到渲染层
    const status = await readStatus(page);
    expect(status.lastCheckAt).toBeNull();
    expect(status.snapshot?.phase).toBe('error');

    // 启动检查调度被跳过：等过 LAUNCH_CHECK_DELAY_MS 后仍无检查发生
    await page.waitForTimeout(LAUNCH_CHECK_DELAY_MS + 1_500);
    const settled = await readStatus(page);
    expect(settled.lastCheckAt).toBeNull();
  });

  test('开关开启：启动检查真实发生并推送渲染层', async () => {
    // 预算 = 实例启动 + 5s 启动检查延迟 + 最坏 45s 检查超时（update-service.ts CHECK_TIMEOUT_MS）
    test.setTimeout(120_000);
    ({ app, page } = await launchElectron({ CODE_AGENT_DEV_UPDATE: '1' }));

    // 轮询启动检查结果：接线生效的可观测证据 = lastCheckAt 被置位 + phase 到达任意终态
    // （无开关时 lastCheckAt 恒为 null，见上一用例）
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
        // available/downloading：远端版本更高，服务已自动开始真实下载 → 立即取消推进到
        // cancelled，防 CI 拉全量包（Windows 约 328MB）
        await page.evaluate(() => window.api.update.cancel());
      }
      await page.waitForTimeout(1_000);
    }

    expect(lastCheckAt).not.toBeNull();
    expect(phase).not.toBeUndefined();
    expect(phase).not.toBe('checking');
    // 防误测：终态必须是真实检查结果，而非手动门卫的消息
    expect(message).not.toContain('开发模式不支持');
  });
});
