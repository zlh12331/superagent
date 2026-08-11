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
    include: ['**/*.test.ts'],
    // 性能基准独立运行（pnpm test:perf:main = vitest run --root src/main perf）：
    // 不进常规 test:main（全量并发下 PTY 类基准时序不稳，且拉长 CI 时长）
    exclude: ['**/*.perf.test.ts'],
    // 覆盖率收集（设计文档 §8.6 覆盖率 CI 卡关）
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // 阈值卡关：低于此值命令失败（exit code ≠ 0）
      // 设计文档 §8.6：statements 80% / branches 75% / functions 80% / lines 80%
      // 基线门槛（2026-08-11 实测，CI test:coverage 卡关；渐进收紧至规范值 80/75/80/80）
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 70,
        lines: 70,
      },
      // 排除测试文件本身、类型声明文件、配置文件、入口文件
      // 这些文件不参与覆盖率统计，避免拉低实际业务代码覆盖率
      exclude: [
        '**/*.test.ts',
        '**/*.config.ts',
        '**/*.d.ts',
        'out/**',
        'node_modules/**',
        // index.ts 是 Electron 入口，依赖 app.whenReady() 无法单测
        'index.ts',
      ],
    },
  },
});
