// e2e/playwright.smoke.config.ts
// 生产构建冒烟测试配置
// ──────────────────────────────────────────────────────────────
// 职责：
// - 针对 electron-builder 打包后的 win-unpacked 可执行文件运行测试
// - 验证生产构建（非 dev 模式）的真实运行情况
// - 覆盖：应用启动、IPC 全链路、SQLite 持久化、preload 注入
//
// 前置条件：
// - 必须先执行 pnpm build:dist 生成 release/win-unpacked/ 目录
// - 测试会自动定位 release/win-unpacked 下的可执行文件
//
// 运行方式：
//   pnpm build:dist && pnpm test:smoke
//
// 与 playwright.electron.config.ts 的区别：
// - electron.config：dev 模式（electron-vite dev），验证开发态
// - smoke.config：生产模式（win-unpacked），验证打包产物
// ──────────────────────────────────────────────────────────────

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  // 只匹配 smoke.prod.spec.ts
  testMatch: '**/smoke.prod.spec.ts',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-smoke' }]],
  use: {
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  // 不启动 webServer：生产构建加载本地文件，无需 dev server
});
