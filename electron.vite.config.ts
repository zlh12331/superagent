import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { visualizer } from 'rollup-plugin-visualizer';
import type { Plugin } from 'vite';

// - main/preload/renderer 统一 'hidden'：生成 .map 文件但不暴露 sourceMappingURL（生产环境推荐）
const SOURCEMAP_MODE = 'hidden' as const;

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
  const plugins: Plugin[] = ([] as Plugin[]).concat(
    react({
      compiler: { compilationMode: 'infer' },
    }),
    tailwindcss(),
  );
  if (ANALYZE_BUNDLE) {
    plugins.push(
      visualizer({
        filename: 'stats/renderer-bundle.html',
        gzipSize: true,
        brotliSize: true,
        json: true,
        template: 'treemap',
      }) as Plugin,
    );
  }
  return plugins;
}

// biome-ignore lint/style/noDefaultExport: electron-vite 框架要求 config 文件必须使用 export default
export default defineConfig({
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
  renderer: {
    root: 'src/renderer',
    resolve: {
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
