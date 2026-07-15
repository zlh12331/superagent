import { defineConfig } from 'vitest/config'
import path from 'path'

// 独立的 Vitest 配置 — 使测试运行器与 Vite 构建插件
// （Sentry Vite 插件、Rolldown Babel、Tailwind CSS）解耦，这些插件仅用于构建。
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // 临时方案：Vite 的 package exports 解析器在处理非 ASCII 路径时会失败，
      // 因此将子路径导出直接映射到物理文件。
      '@testing-library/jest-dom/vitest': path.resolve(
        __dirname,
        'node_modules/@testing-library/jest-dom/dist/vitest.mjs'
      ),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'e2e', 'playwright-report', 'test-results'],
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.spec.{ts,tsx}',
        'src/test/**',
        'src/main.tsx',
        'src/quick-pane-main.tsx',
        'src/vite-env.d.ts',
        'src/lib/bindings.ts',
      ],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 60,
        statements: 60,
      },
    },
  },
})
