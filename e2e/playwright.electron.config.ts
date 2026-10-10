// playwright.electron.config.ts：Electron 真实窗口 E2E 的 Playwright 配置——只收四类 electron 专属 spec（见 testMatch）。
// 用例经 _electron.launch 驱动仓库自身的 Electron，走 preload + IPC 全链路；纯前端 UI 用例归 e2e/playwright.config.ts。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// 仓库根。webServer.cwd 默认取配置文件所在目录（e2e/）而非 cwd，须显式指定：
// 在 e2e/ 下找不到根配置时 electron-vite 会直接退出
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  testDir: '.',
  // 四类 electron 专属 spec：主窗口 + window.api/IPC 全链路（含 DevTools hook）、IPC 性能基准、
  // dev 更新调试（CODE_AGENT_DEV_UPDATE）、--hidden 静默启动
  testMatch: [
    '**/electron.spec.ts',
    '**/perf-electron.spec.ts',
    '**/electron-update-dev.spec.ts',
    '**/electron-hidden-start.spec.ts',
  ],
  // 用例总预算，也是关闭兜底的上限：e2e/helpers/close-electron.ts 的优雅关闭等待（15s）须远低于它，
  // 否则关窗挂起时兜底强杀会被 Playwright 自己的超时掐断
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  workers: 1,
  // 本地不重试：失败立即暴露；CI 另以 --retries=2 覆盖本值，吸收共享 runner 的基准抖动
  retries: 0,
  reporter: [
    ['list'],
    // outputFolder 必须是基于 ROOT 的绝对路径：相对路径按配置文件所在目录（e2e/）解析而非 cwd，
    // 报告会落到 e2e/playwright-report-electron/，与 .github/workflows/ci.yml 从仓库根上传的目录不符
    ['html', { open: 'never', outputFolder: join(ROOT, 'playwright-report-electron') }],
  ],
  use: {
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  // 先拉起 electron-vite dev：端口须与 spec 内的 ELECTRON_RENDERER_URL 一致（主进程据此
  // loadURL 连 dev server 而非 loadFile）；本地已开着 pnpm dev 时复用现有实例
  webServer: {
    command: 'pnpm exec electron-vite dev',
    cwd: ROOT,
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
