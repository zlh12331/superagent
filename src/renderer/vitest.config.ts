// src/renderer/vitest.config.ts
// 渲染层 Vitest 配置
// ──────────────────────────────────────────────────────────────
// 职责：
// - 配置 jsdom 环境（React 组件测试需要 DOM）
// - 注册 setup 文件（全局 mock window.api + ResizeObserver 等）
// - 配置路径别名（与 tsconfig paths 对齐，让 @/* 指向 src/renderer/*）
//
// 设计：
// - 参考官方文档 https://vitest.dev/config/
// - 与 main/shared 配置分离：渲染层需要 jsdom + 路径别名 + setup
// - 覆盖率门槛分层维护（设计文档 §3.3 收紧机制；唯一真源 scripts/coverage-floors.json）
// ──────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// 覆盖率门槛唯一真源：scripts/coverage-floors.json（本文件刻意不内联数字）
// 渲染层真实门槛低于规范值 80/75/80/80，具体数值与该层定位说明只在真源维护，
// 避免「配置是一套、对外表述是另一套」。
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
  // 路径别名：与 src/renderer/tsconfig.json paths 对齐
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
    },
  },
  test: {
    // 启用 globals：允许 describe/it/expect 无需显式 import
    globals: true,
    // 使用 jsdom 环境（React 组件测试需要 DOM API）
    environment: 'jsdom',
    // setup 文件：在所有测试前执行，注册全局 mock
    setupFiles: ['./test/setup-lang.ts', './test/setup.ts'],
    // 测试文件位置：与源码同目录（colocation 模式）
    include: ['**/*.test.{ts,tsx}'],
    // 排除 main 进程、preload、本地参考项目目录（_template，3.9 万文件）、构建产物
    exclude: [
      'node_modules/**',
      'dist/**',
      'out/**',
      '../../_template/**',
      '../../src/main/**',
      '../../src/preload/**',
    ],
    // 覆盖率收集（与 main/shared 对齐）
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // 门槛按设计文档 §3.3 收紧机制维护；floor/ratchet/measured 三元组见真源
      thresholds: {
        statements: rendererFloor.statements,
        branches: rendererFloor.branches,
        functions: rendererFloor.functions,
        lines: rendererFloor.lines,
      },
      // 排除测试文件本身、配置文件、入口文件、参考项目目录
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.config.ts',
        '**/*.d.ts',
        '../../_template/**',
        'test/**',
        'main.tsx',
        'app.tsx',
      ],
    },
  },
});
