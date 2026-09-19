// electron.vite.config.ts
// electron-vite 配置：定义 main / preload / renderer 三个构建入口
// 参考 electron-vite 官方文档 https://electron-vite.org/

import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { visualizer } from 'rollup-plugin-visualizer';
import type { Plugin } from 'vite';

// Source Map 生成配置（用于 Sentry 符号上传）
// - main/preload: 'hidden' 生成 .map 文件但不暴露 sourceMappingURL（生产环境推荐）
// - renderer: 'sourcemap' 标准 source map（Vite 默认开发行为）
// 生成后通过 `pnpm sentry:upload:symbols` 上传到 Sentry
const SOURCEMAP_MODE = 'hidden' as const;

// 包体积分析：`pnpm analyze:bundle` 时启用 rollup-plugin-visualizer
// - 渲染层产物生成交互式 treemap（stats/renderer-bundle.html）+ 机器可读 stats.json
// - 不注入 ANALYZE_BUNDLE=1 时零开销（不参与日常构建）
const ANALYZE_BUNDLE = process.env['ANALYZE_BUNDLE'] === '1';

/**
 * dev-app-update.yml 随 main 构建同步到 out/main
 *
 * electron-updater 未打包时从 app.getAppPath()/dev-app-update.yml 读取调试配置，
 * 而 dev 下（electron out/main/index.js）getAppPath() = out/main——仓库根的该
 * 文件不落位时，CODE_AGENT_DEV_UPDATE=1 的检查链路以 ENOENT 失败
 * （electron-update-dev.spec.ts 实测暴露）。打包版读取的是 electron-builder
 * 生成的 app-update.yml，本文件即使随产物进包也不会被读取（forceDevUpdateConfig
 * 仅在 devUpdateEnabled 时为 true），无条件复制无副作用。
 */
function copyDevAppUpdateYml(): Plugin {
  return {
    name: 'copy-dev-app-update-yml',
    closeBundle() {
      cpSync(
        resolve(__dirname, 'dev-app-update.yml'),
        resolve(__dirname, 'out/main/dev-app-update.yml'),
      );
    },
  };
}

/** 渲染层插件列表（analyze 模式追加体积分析插件） */
function rendererPlugins(): Plugin[] {
  // concat 对数组参数有展平语义：@vitejs/plugin-react v6 返回 Plugin[]，
  // 用 concat 统一拍平，避免元素类型推断成 Plugin | Plugin[] 联合
  const plugins: Plugin[] = ([] as Plugin[]).concat(
    react({
      // React Compiler：启用（oxc 通道）。@vitejs/plugin-react v6 已移除 `babel` 选项，
      // compiler 选项经 oxc-transform-react（peerDep）生效；该依赖缺失时本选项会静默
      // 不产生任何效果（本项目 2026-08 就踩过一次"配置静默忽略"），因此设
      // scripts/check-compiler.ts 在 build 后断言产物含 react/compiler-runtime 编译痕迹。
      // compilationMode 'infer'：自动识别组件/Hook，与存量手写 useMemo/useCallback 共存。
      compiler: { compilationMode: 'infer' },
    }),
    // Tailwind v4 官方 Vite 插件（替代 v3 的 postcss 配置）
    // 文档：https://tailwindcss.com/docs/installation/using-vite
    tailwindcss(),
  );
  if (ANALYZE_BUNDLE) {
    plugins.push(
      // rollup-plugin-visualizer 的返回类型（VisualizerPlugin）与 Vite Plugin
      // 结构兼容但声明独立，push 到 Vite 插件数组需显式兑现
      visualizer({
        filename: 'stats/renderer-bundle.html',
        gzipSize: true,
        brotliSize: true,
        // 同时输出 stats.json 供脚本/CI 解析对比
        json: true,
        template: 'treemap',
      }) as Plugin,
    );
  }
  return plugins;
}

// biome-ignore lint/style/noDefaultExport: electron-vite 框架要求 config 文件必须使用 export default
export default defineConfig({
  // 主进程构建配置
  main: {
    plugins: [copyDevAppUpdateYml()],
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
