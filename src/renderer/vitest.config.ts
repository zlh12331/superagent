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
// - 覆盖率统计与 main/shared 对齐（statements 80% / branches 75%）
// ──────────────────────────────────────────────────────────────

import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

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
    // 排除 main 进程、preload、参考项目、构建产物
    exclude: [
      'node_modules/**',
      'dist/**',
      'out/**',
      '../../docs/**',
      '../../src/main/**',
      '../../src/preload/**',
    ],
    // 覆盖率收集（与 main/shared 对齐）
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // 门槛（2026-08-12 更新：8 批补测后实测 92.87/87.97/90.92，按设计文档 §3.3 收紧机制
      // 新实测−5 缓冲超过规范值 → 取规范值 80/75/80/80；CI(ubuntu) 平台差异余量充足）
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
      // 排除测试文件本身、配置文件、入口文件
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.config.ts',
        '**/*.d.ts',
        'test/**',
        'main.tsx',
        'app.tsx',
      ],
    },
  },
});
