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
// - 覆盖率门槛分层维护（设计文档 §3.3 收紧机制；当前基线见下方 thresholds 注释）
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
      // 门槛按设计文档 §3.3 收紧机制维护：新实测−5 缓冲，逼近规范值 80/75/80/80。
      // 2026-08-27 全链审计实测 64.06/55.91/59.96/64.87（此前注释声称 92.87 与实测不符，
      // 已纠正：技术栈全量升级后口径变化 + settings/chat 组件存量缺口）。
      // 本轮已补测 stores 层（+42 用例，60.71→64.06），剩余缺口（settings 组件 ~21%、
      // Markdown/message-item 等）待后续批次补测后按机制上调。
      thresholds: {
        statements: 59,
        branches: 50,
        functions: 54,
        lines: 59,
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
