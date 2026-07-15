import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright E2E 配置，用于 Tauri 应用前端测试。
 *
 * 测试在 Vite dev server 上运行并使用 Mock 的 Tauri API，
 * 可在无需 Rust 后端的情况下进行完整的 UI 交互测试。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // 8 workers 并行时 Vite dev server 首次编译压力大，
  // 限制为 2 个 worker 降低并发负载，避免 beforeEach 超时
  workers: process.env.CI ? 1 : 2,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  // Vite dev server 冷启动 + AxeBuilder 分析需要更长的超时
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },

  use: {
    baseURL: 'http://localhost:1420',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI,
    // Vite dev server 冷启动可能需要较长时间
    timeout: 120_000,
    env: {
      VITE_SENTRY_DSN: 'https://test@test.ingest.sentry.io/123',
    },
  },
})
