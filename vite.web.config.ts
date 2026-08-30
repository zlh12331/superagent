// vite.web.config.ts
// 前端独立开发模式配置（浏览器运行，无 Electron 主进程）
// ──────────────────────────────────────────────────────────────
// 用途：pnpm dev:web —— 让前端开发者脱离 Electron 单独开发渲染层。
// - 复用 electron.vite.config.ts 的 renderer 配置（root/alias/插件）
// - 通过 --mode web 让 main.tsx 检测到 import.meta.env.MODE === 'web'
//   时动态注入 dev/mock-api.ts 的完整 mock window.api
// - 生产构建与 electron-vite dev（E2E 模式）不受影响（MODE 不同）
// ──────────────────────────────────────────────────────────────

import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// biome-ignore lint/style/noDefaultExport: vite 配置文件要求 export default
export default defineConfig({
  // 与 electron.vite.config.ts renderer 对齐
  root: 'src/renderer',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
    },
  },
  plugins: [
    // React Compiler 未启用：@vitejs/plugin-react v6 已无 Babel 通道，旧 babel.plugins
    // 配置会被静默忽略（与 electron.vite.config.ts 一致），渲染层仍需手写 useMemo/useCallback
    react(),
    tailwindcss(),
  ],
  server: {
    port: 5173,
    // E2E（electron-vite dev）也占用 5173：web 模式自动换端口避免冲突
    strictPort: false,
  },
  build: {
    outDir: resolve(__dirname, 'out/web'),
  },
});
