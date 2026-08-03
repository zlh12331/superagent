// e2e/playwright.electron.config.ts
// Playwright Electron E2E 测试配置（方案 E）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 配置 Electron E2E 测试运行环境
// - 用 _electron.launch 启动真实 Electron（连接到 dev server）
// - 验证 window.api 全链路 IPC、React DevTools、Profiler 埋点
//
// 前置条件：
// - dev server 必须已启动（pnpm dev）
// - main + preload 必须已构建（pnpm dev 会自动构建）
//
// 运行方式：
//   1. 先启动 dev server：pnpm dev（保持运行）
//   2. 另开终端跑测试：pnpm test:e2e:electron
//
// 与 playwright.config.ts（纯浏览器模式）的区别：
// - playwright.config.ts：浏览器访问 localhost:5173，无 preload，测纯前端 UI
// - playwright.electron.config.ts：_electron.launch 启动 Electron，有 preload + IPC 全链路
// ──────────────────────────────────────────────────────────────

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  // 只匹配 electron.spec.ts，不匹配 smoke.spec.ts
  testMatch: '**/electron.spec.ts',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-electron' }]],
  use: {
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  // 自动启动 dev server（与 playwright.config.ts 一致；本地已手动运行时自动复用）
  webServer: {
    command: 'pnpm exec electron-vite dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
