// src/main/vitest.config.ts
// main 进程 Vitest 配置
// 参考 Vitest 4 官方文档 https://vitest.dev/config/
import { defineConfig } from 'vitest/config';

// biome-ignore lint/style/noDefaultExport: vitest config 框架要求必须使用 export default
export default defineConfig({
  test: {
    // 启用 globals：允许 describe/it/expect 无需显式 import
    globals: true,
    // 测试文件位置：与源码同目录（colocation 模式）
    include: ['__tests__/**/*.test.ts'],
    // 覆盖率收集
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
