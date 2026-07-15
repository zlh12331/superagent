import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import path, { resolve } from 'path'
import { readFileSync } from 'fs'

// 通过 fs 读取 package.json，以避免 oxc-parser（knip 使用）
// 无法处理的 JSON import 语法。参见：https://knip.dev/reference/known-issues
const packageJson = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf-8')
) as { version: string }

const host = process.env.TAURI_DEV_HOST

// Vite 配置参考：https://vitejs.dev/config/
export default defineConfig(async ({ mode }) => {
  const sentryDsn = process.env.VITE_SENTRY_DSN;

  return {
    define: {
      __APP_VERSION__: JSON.stringify(packageJson.version),
    },
    plugins: [
      react(),
      babel({
        presets: [reactCompilerPreset()],
      }),
      tailwindcss(),
      // Sentry Vite 插件：自动上传 source map 并设置 release。
      // 仅在配置 SENTRY_DSN 时生效（构建与开发模式均生效）。
      sentryDsn &&
        sentryVitePlugin({
          org: 'sentry',
          project: 'codex-desktop',
          authToken: process.env.SENTRY_AUTH_TOKEN, // source map 上传所需
          // release 与 package.json version 对齐，确保 Sentry 后台能按版本分组
          release: { name: packageJson.version },
          // Source map：生产环境生成隐藏 map，并上传至 Sentry。
          sourcemaps: {
            assets: './dist/**',
            // v5 正确 API：用函数判断是否忽略（ignore 字段非标准）
            filesIgnoreAfterBuild: (filepath: string) =>
              filepath.includes('node_modules'),
          },
          // 开发模式或缺少 authToken 时禁用 — 避免干扰 HMR 与 CI 静默失败
          disabled:
            mode === 'development' || !process.env.SENTRY_AUTH_TOKEN,
        }),
    ].filter(Boolean),
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      chunkSizeWarningLimit: 600,
      sourcemap: mode === 'production' ? 'hidden' : false,
      // 显式锁定目标环境为 ES2022（与 tsconfig.json target 对齐），
      // Tauri 运行在 WebView2/WKWebView 现代内核，无需降级转译
      target: 'es2022',
      rolldownOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          'quick-pane': resolve(__dirname, 'quick-pane.html'),
        },
        output: {
          // manualChunks 拆分大体积 vendor，避免 main chunk 过大（966KB → ~300KB）
          // 按依赖职责分组，利用浏览器缓存（vendor 变更频率低于业务代码）
          // 注意：Rolldown 要求 manualChunks 为函数形式（非对象）
          manualChunks(id) {
            // React 核心 — react + react-dom + scheduler
            if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/') || id.includes('node_modules/scheduler/')) {
              return 'vendor-react'
            }
            // Sentry SDK（含 Replay/Feedback 集成，约 100KB+）
            if (id.includes('node_modules/@sentry/')) {
              return 'vendor-sentry'
            }
            // 终端模拟器（xterm + addons）
            if (id.includes('node_modules/@xterm/')) {
              return 'vendor-xterm'
            }
            // Markdown 渲染管线（react-markdown + remark-gfm + rehype-highlight）
            if (
              id.includes('node_modules/react-markdown/') ||
              id.includes('node_modules/remark-gfm/') ||
              id.includes('node_modules/rehype-highlight/') ||
              id.includes('node_modules/lowlight/') ||
              id.includes('node_modules/highlight.js/')
            ) {
              return 'vendor-markdown'
            }
            // Radix UI 原语集合
            if (id.includes('node_modules/@radix-ui/')) {
              return 'vendor-radix'
            }
            // 动画库 — motion（~50KB gzip，变更频率低，独立缓存）
            if (
              id.includes('node_modules/motion/') ||
              id.includes('node_modules/motion-dom/') ||
              id.includes('node_modules/motion-utils/')
            ) {
              return 'vendor-motion'
            }
            // 表单 + 校验 — react-hook-form + zod + @hookform（~80KB gzip）
            if (
              id.includes('node_modules/react-hook-form/') ||
              id.includes('node_modules/zod/') ||
              id.includes('node_modules/@hookform/')
            ) {
              return 'vendor-form'
            }
            // i18n — i18next + react-i18next（~30KB gzip）
            if (
              id.includes('node_modules/i18next/') ||
              id.includes('node_modules/react-i18next/')
            ) {
              return 'vendor-i18n'
            }
            // 数据层 — @tanstack/react-query（~35KB gzip）
            if (id.includes('node_modules/@tanstack/react-query/')) {
              return 'vendor-query'
            }
            // 轻量 UI 工具集合 — cmdk / sonner / cva / clsx / tailwind-merge / resizable-panels / zustand
            if (
              id.includes('node_modules/cmdk/') ||
              id.includes('node_modules/sonner/') ||
              id.includes('node_modules/class-variance-authority/') ||
              id.includes('node_modules/clsx/') ||
              id.includes('node_modules/tailwind-merge/') ||
              id.includes('node_modules/react-resizable-panels/') ||
              id.includes('node_modules/zustand/')
            ) {
              return 'vendor-ui-utils'
            }
          },
        },
      },
    },
  // 专为 Tauri 开发定制的 Vite 选项，仅在 `tauri dev` 或 `tauri build` 时生效
  //
  // 1. 防止 Vite 清屏掩盖 Rust 错误
  clearScreen: false,
  // 2. Tauri 要求固定端口，端口被占用时直接失败
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. 告知 Vite 忽略 `src-tauri` 目录的监听
      ignored: ['**/src-tauri/**'],
    },
  },
  }
})
