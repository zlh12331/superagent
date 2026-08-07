// tests/integration/vitest.config.ts
// 集成测试配置（跨服务真实协作验证）
// ──────────────────────────────────────────────────────────────
// 与单测的区别：
// - 单测（src/main/**/*.test.ts）：服务 + fake 依赖（DI 接口）
// - 集成（本目录）：多个真实服务 + 真实内存 DB 的协作验证 + DB 约束验证
//
// 环境：Node（主进程服务均为 Node 环境）
// ──────────────────────────────────────────────────────────────

import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// biome-ignore lint/style/noDefaultExport: vitest config 框架要求必须使用 export default
export default defineConfig({
  resolve: {
    alias: {
      // 集成测试引用主进程源码（相对路径即可，无需 alias；保留以备扩展）
      '@main': resolve(__dirname, '../src/main'),
    },
  },
  test: {
    // 与 src/main / src/renderer 保持一致：启用 globals
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**'],
  },
});
