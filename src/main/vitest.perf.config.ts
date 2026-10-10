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
