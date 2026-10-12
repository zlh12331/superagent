// vitest.config.ts：集成测试配置——与单测的区别在「真实协作」：setup.ts 只替身
// Electron SDK 边界，service/存储/文件系统全走真实实现（含内存外临时目录）；
// testTimeout 60s（真实 git/rg/pty 子进程比单测慢一个量级，5s 默认必超时）；
// @main 别名供测试直取主进程模块

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
