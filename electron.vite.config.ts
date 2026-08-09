// electron.vite.config.ts
// electron-vite 配置：定义 main / preload / renderer 三个构建入口
// 参考 electron-vite 官方文档 https://electron-vite.org/

import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { visualizer } from 'rollup-plugin-visualizer';

// Source Map 生成配置（用于 Sentry 符号上传）
// - main/preload: 'hidden' 生成 .map 文件但不暴露 sourceMappingURL（生产环境推荐）
// - renderer: 'sourcemap' 标准 source map（Vite 默认开发行为）
// 生成后通过 `pnpm sentry:upload:symbols` 上传到 Sentry
const SOURCEMAP_MODE = 'hidden' as const;

// 包体积分析：`pnpm analyze:bundle` 时启用 rollup-plugin-visualizer
// - 渲染层产物生成交互式 treemap（stats/renderer-bundle.html）+ 机器可读 stats.json
// - 不注入 ANALYZE_BUNDLE=1 时零开销（不参与日常构建）
const ANALYZE_BUNDLE = process.env.ANALYZE_BUNDLE === '1';

/** 渲染层插件列表（analyze 模式追加体积分析插件） */
function rendererPlugins() {
  const plugins = [
    react({
      // 启用 React Compiler（React 19.2 官方推荐，自动 memoize）
      // 注意：Virtuoso 使用文件（Sidebar/ChatMessageList）顶部用 'use no memo' 精确禁用
      // —— 全量模式与 Virtuoso 的 ref 内部状态不兼容（data 更新不触发渲染）
      babel: {
        plugins: [['babel-plugin-react-compiler']],
      },
    }),
    // Tailwind v4 官方 Vite 插件（替代 v3 的 postcss 配置）
    // 文档：https://tailwindcss.com/docs/installation/using-vite
    tailwindcss(),
  ];
  if (ANALYZE_BUNDLE) {
    plugins.push(
      visualizer({
        filename: 'stats/renderer-bundle.html',
        gzipSize: true,
        brotliSize: true,
        // 同时输出 stats.json 供脚本/CI 解析对比
        json: true,
        template: 'treemap',
      }),
    );
  }
  return plugins;
}

// biome-ignore lint/style/noDefaultExport: electron-vite 框架要求 config 文件必须使用 export default
export default defineConfig({
  // 主进程构建配置
  main: {
    build: {
      sourcemap: SOURCEMAP_MODE,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
        },
      },
    },
  },
  // Preload 脚本构建配置
  // 输出 CJS 格式（.cjs）：sandbox: true 下 preload 必须是 CommonJS
  // 参考 electron-vite ESM 限制：https://electron-vite.org/guide/dev#limitations-of-sandboxing
  preload: {
    build: {
      sourcemap: SOURCEMAP_MODE,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  // 渲染层（React 19.2 + Vite 8 + React Compiler + Tailwind v4）配置
  renderer: {
    root: 'src/renderer',
    resolve: {
      // 与 tsconfig.json paths 对齐，让 Vite 能解析 @/* 别名
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
      },
    },
    build: {
      sourcemap: SOURCEMAP_MODE,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
    plugins: rendererPlugins(),
  },
});
