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
      // 分层规范值（设计文档 §3.3）：shared 是 IPC schema/常量/类型声明包，
      // 分支/函数天然低（有效覆盖理念）——规范 80/30/40/80，不套业务层 80/75/80/80
      // 防倒退缓冲：当前门槛 = 实测 − 5 点（2026-08-11 实测 84.49/18.57/33.33），
      // 避免"贴地"阈值（原 18/33 余量 <1 点）在新增逻辑时误伤 CI
      // 收紧触发：覆盖率提升后，门槛跟随"新实测 − 5 缓冲"上调（设计文档 §3.3）
      thresholds: {
        statements: 80,
        branches: 13,
        functions: 28,
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
