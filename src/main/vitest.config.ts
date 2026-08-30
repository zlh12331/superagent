// src/main/vitest.config.ts
// main 进程 Vitest 配置
// 参考 Vitest 4 官方文档 https://vitest.dev/config/
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// 覆盖率门槛唯一真源：scripts/coverage-floors.json
// 此处刻意不内联任何数字——门槛变更只能改真源，
// 且由 scripts/check-coverage-floors.ts 校验「floor ≥ ratchet」与实测自洽性。
type FloorsFile = {
  layers: {
    main: {
      floor: { statements: number; branches: number; functions: number; lines: number };
    };
  };
};
const mainFloor = (
  JSON.parse(
    readFileSync(join(__dirname, '../../scripts/coverage-floors.json'), 'utf-8'),
  ) as FloorsFile
).layers.main.floor;

// biome-ignore lint/style/noDefaultExport: vitest config 框架要求必须使用 export default
export default defineConfig({
  test: {
    // 启用 globals：允许 describe/it/expect 无需显式 import
    globals: true,
    // 测试文件位置：与源码同目录（colocation 模式）
    include: ['**/*.test.ts'],
    // 性能基准独立运行（pnpm test:perf:main = vitest.perf.config.ts）：
    // 不进常规 test:main（全量并发下 PTY 类基准时序不稳，且拉长 CI 时长）。
    // 注意：此排除项无法用 CLI --exclude 撤销（Vitest 4 的 --exclude 只做合并），
    // 故基准必须走 vitest.perf.config.ts 这份独立配置。
    exclude: ['**/*.perf.test.ts'],
    // 覆盖率收集（设计文档 §8.6 覆盖率 CI 卡关）
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // 阈值卡关：低于此值命令失败（exit code ≠ 0）
      // 门槛数值与各层最近一次实测统一记录在 scripts/coverage-floors.json，
      // 本文件不再抄写数字（抄写会漂移，且历史上曾出现「注释自称 80/75/80/80」
      // 而真实门槛远低的情况）。
      thresholds: {
        statements: mainFloor.statements,
        branches: mainFloor.branches,
        functions: mainFloor.functions,
        lines: mainFloor.lines,
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
