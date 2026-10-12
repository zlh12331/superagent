// electron.vite.config.ts：Electron 三进程构建配置（main / preload / renderer 的入口、别名与插件）
// 仅服务 `pnpm dev` / `pnpm build`；浏览器模式的 dev 走 vite.web.config.ts——同一份渲染层
// 源码的另一套入口配置，故 renderer 的 root/alias/插件改动需在两处同步

import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { visualizer } from 'rollup-plugin-visualizer';
import type { Plugin } from 'vite';

// 'hidden' 生成 .map 但不写 sourceMappingURL 注释（生产推荐形态）：排障靠构建机 out/ 里的
// .map，安装包侧由 electron-builder.yml 的 "!**/*.map" 整体排除（无云端符号上传，出错走本地日志）
const SOURCEMAP_MODE = 'hidden' as const;

// `pnpm analyze:bundle` 以 ANALYZE_BUNDLE=1 触发；未置位时体积分析插件不进插件链，日常构建零开销
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
    // @vitejs/plugin-react v6 返回 Plugin[]，concat 对数组参数有展平语义，
    // 故用 concat 起步避免元素类型推断成 Plugin | Plugin[]
    react({
      // React Compiler 经 oxc 通道生效（v6 已无 babel 选项）；oxc-transform-react 是可选
      // peerDep，缺失时本配置静默失效，由 pnpm check:compiler 在 build 后断言产物含
      // react/compiler-runtime 痕迹兜底。'infer' = 自动识别组件/Hook，与手写 memo 共存
      compiler: { compilationMode: 'infer' },
    }),
    // Tailwind v4 官方 Vite 插件（v4 起不再走 postcss 配置链路）
    tailwindcss(),
  );
  if (ANALYZE_BUNDLE) {
    plugins.push(
      // 插件返回类型 VisualizerPlugin 与 Vite Plugin 结构兼容但声明独立，push 进插件数组需显式兑现
      visualizer({
        filename: 'stats/renderer-bundle.html',
        gzipSize: true,
        brotliSize: true,
        // 本仓所用 rollup-plugin-visualizer 7.x 中该选项已弃用，且会把 template 覆写为 raw-data——
        // 故 filename 落盘的是原始 JSON 数据（stats/ 已 gitignore），而非 treemap 页面
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
          // sandbox: true 要求 preload 是 CommonJS；根 package.json 为 type: module，
          // 故同时固定 .cjs 扩展名，保证按 CJS 加载
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      // 与 src/renderer/tsconfig.json 的 paths（@/* → ./*）对齐；vite.web.config.ts 有同款别名
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
