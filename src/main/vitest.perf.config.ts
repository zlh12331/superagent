// vitest.perf.config.ts：主进程性能基准（*.perf.test.ts）；单线程串行跑（基准怕并发扰动），
// 超时放宽到 2 分钟，不产出覆盖率
import { defineConfig } from 'vitest/config';

// biome-ignore lint/style/noDefaultExport: vitest config 框架要求必须使用 export default
export default defineConfig({
  test: {
    globals: true,
    include: ['**/*.perf.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'out/**'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: { enabled: false },
  },
});
