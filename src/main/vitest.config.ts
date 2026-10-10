// vitest.config.ts：主进程单测配置（pnpm test:main 的 --root 指向本目录）；
// 覆盖率阈值从 scripts/coverage-floors.json 的 main 层读取（数字真源不在本文件）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

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
    globals: true,
    include: ['**/*.test.ts'],
    exclude: ['**/*.perf.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        statements: mainFloor.statements,
        branches: mainFloor.branches,
        functions: mainFloor.functions,
        lines: mainFloor.lines,
      },
      exclude: [
        '**/*.test.ts',
        '**/*.config.ts',
        '**/*.d.ts',
        'out/**',
        'node_modules/**',
        'index.ts',
      ],
    },
  },
});
