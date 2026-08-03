// scripts/vitest.config.ts
// scripts 目录 Vitest 配置（脚手架纯函数测试，Node 环境）
// 注：scripts/**/*.ts 的 biome override 已放行 noDefaultExport，config 可直接用 export default
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 与 src/main / src/renderer 保持一致：启用 globals（describe/it/expect 无需显式 import）
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    // 排除工具型文件（CLI 入口通过真实演练验证，不纳入单测）
    exclude: ['**/node_modules/**', '**/scaffold-ipc.ts', '**/scaffold-tool.ts'],
  },
});
