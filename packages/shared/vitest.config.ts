// vitest.config.ts：@code-agent/shared 共享包的单测配置（用例范围 + 覆盖率门槛，阈值来自 scripts/coverage-floors.json）
// 边界：只管本包的用例与覆盖率；main / renderer / scripts 各有独立 vitest.config.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// 覆盖率阈值不在本文件内联：唯一真源是 scripts/coverage-floors.json。`pnpm check:coverage-floors`
// 按文本断言本文件出现 coverage-floors.json 与 layers.shared.floor 字样、thresholds 块内无字面数字，
// 故下方取值拼写勿改写；shared 是契约层，分支/函数门槛低于业务层系有意定位（floor/ratchet/measured 只在真源维护）。
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
    // 与 packages/shared/tsconfig.json 的 types: ["vitest/globals"] 配套；本包用例仍显式 import，两者不可单独改动
    globals: true,
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // lcov.info 是 VS Code Coverage Gutters 的行级覆盖数据源（.vscode/settings.json 按 coverage/lcov.info 定位），去掉即失去该可视化
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        statements: sharedFloor.statements,
        branches: sharedFloor.branches,
        functions: sharedFloor.functions,
        lines: sharedFloor.lines,
      },
      // 末尾 index.ts 是再导出聚合（唯一手写物是 SHARED_VERSION 常量），无业务逻辑可覆盖，计入分母只会拉低本层读数
      exclude: ['src/**/*.test.ts', 'src/**/*.config.ts', 'src/**/*.d.ts', 'src/index.ts'],
    },
  },
});
