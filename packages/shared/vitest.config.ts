// packages/shared/vitest.config.ts
// Vitest 配置：@code-agent/shared 工作空间包单测
// 参考 Vitest 4 官方文档 https://vitest.dev/config/
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// 覆盖率门槛唯一真源：scripts/coverage-floors.json（本文件刻意不内联数字）
// shared 是 IPC schema/常量/类型包，分支与函数天然低于业务层——该定位说明与
// floor/ratchet/measured 三元组都只在真源维护，避免文档口径与配置口径两套数字。
type FloorsFile = {
  layers: {
    shared: {
      floor: { statements: number; branches: number; functions: number; lines: number };
    };
  };
};
const sharedFloor = (
  JSON.parse(
    readFileSync(join(__dirname, '../../scripts/coverage-floors.json'), 'utf-8'),
  ) as FloorsFile
).layers.shared.floor;

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
      thresholds: {
        statements: sharedFloor.statements,
        branches: sharedFloor.branches,
        functions: sharedFloor.functions,
        lines: sharedFloor.lines,
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
