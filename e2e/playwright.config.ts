// e2e/playwright.config.ts
// Playwright E2E 测试配置
// 设计文档 §8.4 E2E 测试策略 / Phase 10 Task 1
//
// 职责：
// - 配置 E2E 测试运行环境（纯浏览器模式）
// - 通过 webServer 自动启动 renderer vite dev server
// - 失败时截图 + 视频 + trace（便于调试）
// - workers: 1 串行执行
//
// 注意：
// - 渲染层已支持 mock fallback（api/client.ts），无需 Electron preload
// - E2E 测试直接访问 http://localhost:5173，测试纯 Web UI
// - 真实 Electron 环境测试留待打包阶段（Phase 11）

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// 仓库根（webServer 的 cwd 默认是配置文件目录，不显式指定会导致 vite 在
// e2e/ 下找不到 --config 相对路径而提前退出，2026-08-27 实测暴露）
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  // 排除需要专属配置运行的测试文件：
  // - electron.spec.ts / perf-electron.spec.ts / electron-update-dev.spec.ts：
  //   使用 _electron fixture，需 playwright.electron.config.ts
  // - smoke.prod.spec.ts：需打包产物，需 playwright.smoke.config.ts
  testIgnore: [
    '**/electron.spec.ts',
    '**/perf-electron.spec.ts',
    '**/electron-update-dev.spec.ts',
    '**/smoke.prod.spec.ts',
  ],
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  // 自动启动 renderer dev server
  // 浏览器模式 = dev:web（--mode web，注入 mock window.api）——与 electron-vite dev
  // （development 模式，无 mock）区分：ipc-rtt 等 mock 链路基准依赖 web 模式
  webServer: {
    command: 'pnpm exec vite --config vite.web.config.ts --mode web',
    cwd: ROOT,
    url: 'http://localhost:5173',
    timeout: 60_000,
    reuseExistingServer: true,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
