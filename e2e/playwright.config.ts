// e2e/playwright.config.ts：浏览器模式 E2E 配置——webServer 拉起 vite.web.config.ts（--mode web，渲染层注入 mock window.api），
// 跑 journey / visual / a11y / perf 等纯浏览器用例。
// 边界：真实 Electron 窗口归 playwright.electron.config.ts、打包产物归 playwright.smoke.config.ts，两类用例在本文件按 testIgnore 排除。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// 仓库根：webServer.cwd 默认取配置文件所在目录（e2e/），不显式指定则 vite 解析不到 --config vite.web.config.ts 相对路径而提前退出
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  // 排除必须由专属配置运行的用例：electron* 走 _electron fixture（playwright.electron.config.ts）；
  // perf-electron 同属 Electron 配置，因文件名不以 electron 开头需单列；smoke.prod 需打包产物（playwright.smoke.config.ts）
  testIgnore: ['**/electron*.spec.ts', '**/perf-electron.spec.ts', '**/smoke.prod.spec.ts'],
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  workers: 1, // 串行执行：单次运行只有一个 dev server（vite.web.config.ts 的 strictPort 5199），visual/perf 基线也在本配置下跑
  retries: 0, // 默认不重试；CI 用 --retries=2 吸收 journey 套件偶发 flaky（见 .github/workflows/ci.yml 的 e2e-browser job）
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    // 5199 与 electron-vite dev（5173）分离：reuseExistingServer 会复用占用该端口的既有服务，
    // 遗留的无 mock 服务一旦被复用，页面停在裸态导致用例连环红——端口分离即为此根治
    baseURL: 'http://localhost:5199',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  // 自动拉起 renderer dev server：必须 --mode web——main.tsx 仅在 import.meta.env.MODE === 'web' 时注入 mock window.api，
  // 而 electron-vite dev（5173，无 mock）是另一个服务；ipc-rtt 等基准也只在 mock 链路下有度量对象
  webServer: {
    command: 'pnpm exec vite --config vite.web.config.ts --mode web',
    cwd: ROOT,
    url: 'http://localhost:5199',
    timeout: 60_000,
    reuseExistingServer: true,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'chromium', // 唯一目标浏览器：应用本体是 Electron（Chromium 内核），CI 也只安装 chromium
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
