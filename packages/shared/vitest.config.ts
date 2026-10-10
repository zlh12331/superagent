import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

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
    globals: true,
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        statements: sharedFloor.statements,
        branches: sharedFloor.branches,
        functions: sharedFloor.functions,
        lines: sharedFloor.lines,
      },
      exclude: ['src/**/*.test.ts', 'src/**/*.config.ts', 'src/**/*.d.ts', 'src/index.ts'],
    },
  },
});
