import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// biome-ignore lint/style/noDefaultExport: vite 配置文件要求 export default
export default defineConfig({
  root: 'src/renderer',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
    },
  },
  plugins: [react({ compiler: { compilationMode: 'infer' } }), tailwindcss()],
  server: {
    port: 5199,
    strictPort: true,
  },
  build: {
    outDir: resolve(__dirname, 'out/web'),
  },
});
