// e2e/smoke.prod.spec.ts：生产构建冒烟——用 _electron.launch 直接启动 electron-builder 打包产物
// （release/ 下的 unpacked 可执行文件，而非 dev server），验证打包链路没把应用打坏。
// 只覆盖「能起来」这一层：主界面渲染 / preload 注入 / IPC 全链路（含 SQLite 初始化）/ 启动耗时；
// dev 专属行为不在生产构建里（React DevTools 仅在 !app.isPackaged 时安装，src/main/window.ts），
// 那部分由 e2e/electron.spec.ts 覆盖。
// 前置：pnpm build:dist 产出 release/；运行 pnpm test:smoke（release.yml 各平台 build job 同用此命令）。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

// 下面两个名字必须与 electron-builder.yml 的产物命名一致（productName / linux.executableName）：
// 改打包配置时这里要同步，否则路径解析全落空，只会以「可执行文件不存在」的形式失败
const PRODUCT_NAME = 'Code Agent Desktop';
const LINUX_EXECUTABLE = 'code-agent-desktop';

/** 当前架构对应的 unpacked 目录后缀（x64 为默认架构，无后缀） */
const ARCH_SUFFIX = process.arch === 'arm64' ? '-arm64' : '';

/**
 * 按候选顺序返回第一个存在的路径。
 *
 * 全都不存在时返回首选路径，好让调用方的前置检查以「可执行文件不存在」报错，而不是得到空串。
 */
function firstExisting(candidates: readonly string[]): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? '';
}

// 打包产物路径按平台解析（unpacked 目录名带架构后缀，x64 无后缀——见 ARCH_SUFFIX）：
// Windows/Linux 为 release/<platform>[-arm64]-unpacked/，macOS 为 release/mac[-arm64|-x64]/*.app/Contents/MacOS/。
// 候选顺序把当前进程架构的目录排前：只有本机架构的构建才一定能在本机启动，其余目录仅作回退。
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

/** 启动打包产物并返回 DOM 就绪的首窗；可执行文件缺失时抛出带构建提示的错误 */
async function launchPackagedApp(): Promise<{ app: ElectronApplication; page: Page }> {
  if (!existsSync(EXECUTABLE_PATH)) {
    throw new Error(`可执行文件不存在：${EXECUTABLE_PATH}\n请先执行 pnpm build:dist 生成打包产物`);
  }

  const app = await electron.launch({
    executablePath: EXECUTABLE_PATH,
    // 生产构建不经 ELECTRON_RENDERER_URL，主进程 loadFile 加载打包内的 renderer（src/main/window.ts）
    env: {
      ...process.env,
      // 压成 production：runner 继承的 NODE_ENV=test 会让 appEnv 判成 test（src/main/config/index.ts）
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

  // 每条用例独立启停应用：避免残留窗口 / 单实例锁（src/main/index.ts）影响下一条
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
    // 这里只抽样关键域（完整清单真源：packages/shared/src/ipc/meta.ts）；断言 models 而非 codebase——
    // codebase 查询走工具（src/main/infra/ai/tools/codebase.tool.ts），不占独立 IPC 域
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

    // session/list 直连 SQLite：返回 data 即证明打包产物的库初始化（含 drizzle 迁移）成功
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
    // isPackaged 取自 Electron 的 app.isPackaged（src/main/ipc/system.handler.ts）：
    // 断言 true 才说明被测的是打包产物本身，而非源码启动
    expect(result.isPackaged).toBe(true);
  });

  test('生产构建启动到可交互 < 10s（分段报告）', async () => {
    // 前置检查与 launchPackagedApp 等价，但本用例要分段计时，故不共用而独立实现
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

    // UI 就绪判据：React 挂载后才会渲染出聊天输入框（src/renderer/components/chat/ChatInput.tsx）
    const input = page.locator('textarea').first();
    // 单步上限 15s，宽于总预算 10s：冷启动慢时报「输入框始终不可见」，即 React 未挂载这一具体症状
    await expect(input).toBeVisible({ timeout: 15_000 });
    const t4 = Date.now();

    // 「可交互」判据：能对输入框完成一次输入操作，而不只是元素出现
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

    // 渲染期报错在 load 之后才到达，没有「收齐」事件可等，故留固定观察窗口
    await page.waitForTimeout(2000);

    // 滤掉非阻塞噪音（DevTools 安装提示、CSP 相关输出）：它们不代表业务回归，但会让用例常红
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes('DevTools') &&
        !e.includes('Download the React DevTools') &&
        !e.includes('Content Security Policy'),
    );

    expect(criticalErrors).toEqual([]);
  });
});
