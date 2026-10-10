import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// biome-ignore lint/style/noDefaultExport: vitest config 框架要求必须使用 export default
export default defineConfig({
  resolve: {
    alias: {
      '@main': resolve(__dirname, '../src/main'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**'],
    testTimeout: 60_000,
    setupFiles: ['./setup.ts'],
  },
});
