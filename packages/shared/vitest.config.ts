// packages/shared/vitest.config.ts
// Vitest 配置：@code-agent/shared 工作空间包单测
// 参考 Vitest 4 官方文档 https://vitest.dev/config/
import { defineConfig } from 'vitest/config';

// biome-ignore lint/style/noDefaultExport: Vitest 框架要求 config 文件必须使用 export default
export default defineConfig({
  test: {
    // 启用 globals：允许 describe/it/expect 无需显式 import
    globals: true,
    // 测试文件位置：与源码同目录（colocation 模式，设计文档 §8.2）
    include: ['src/**/*.test.ts'],
    // 覆盖率收集（设计文档 §8.6 覆盖率 CI 卡关）
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // 阈值卡关：低于此值命令失败（exit code ≠ 0）
      // 设计文档 §8.6：statements 80% / branches 75% / functions 80% / lines 80%
      // 基线门槛（2026-08-11 实测，CI test:coverage 卡关；渐进收紧至规范值 80/75/80/80）
      thresholds: {
        statements: 80,
        branches: 18,
        functions: 33,
        lines: 80,
      },
      // 排除测试文件本身、类型声明文件、配置文件、入口文件
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.config.ts',
        'src/**/*.d.ts',
        // index.ts 是 re-export 聚合文件，无业务逻辑
        'src/index.ts',
      ],
    },
  },
});
