import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

type FloorsFile = {
  layers: {
    renderer: {
      floor: { statements: number; branches: number; functions: number; lines: number };
    };
  };
};
const rendererFloor = (
  JSON.parse(
    readFileSync(join(__dirname, '../../scripts/coverage-floors.json'), 'utf-8'),
  ) as FloorsFile
).layers.renderer.floor;

// biome-ignore lint/style/noDefaultExport: vitest config 框架要求必须使用 export default
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./test/setup-lang.ts', './test/setup.ts'],
    include: ['**/*.test.{ts,tsx}'],
    exclude: [
      'node_modules/**',
      'dist/**',
      'out/**',
      '../../_template/**',
      '../../src/main/**',
      '../../src/preload/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      thresholds: {
        statements: rendererFloor.statements,
        branches: rendererFloor.branches,
        functions: rendererFloor.functions,
        lines: rendererFloor.lines,
      },
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.config.ts',
        '**/*.d.ts',
        '../../_template/**',
        'test/**',
        'main.tsx',
        'App.tsx',
      ],
    },
  },
});
