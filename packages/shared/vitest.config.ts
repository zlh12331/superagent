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
    // 覆盖率收集（设计文档 §3.3）
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // 阈值卡关：低于此值命令失败（exit code ≠ 0）
      // 分层规范值（设计文档 §3.3）：shared 是 IPC schema/常量/类型声明包——
      // zod schema 与类型映射的"有效分支"天然难以覆盖，分支/函数显著低于
      // 业务层 80/75/80/80 是**有意的类型包定位**（不是漏测）。规范目标 80/30/40/80。
      // 2026-08-27 全链审计按棘轮机制上调：实测 89.06/44.44/44.82/88.95，
      // 分支取规范值 30，函数取实测−5=39（低于规范 40，补测后继续上调）。
      thresholds: {
        statements: 80,
        branches: 30,
        functions: 39,
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
