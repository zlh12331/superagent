// @ts-nocheck
// vitest.workspace.ts
// VS Code Vitest Explorer 多配置聚合
// 参考: https://vitest.dev/guide/workspace
import { defineWorkspace } from 'vitest/config';

// biome-ignore lint/style/noDefaultExport: vitest workspace 要求 export default
export default defineWorkspace([
  'src/main',
  'src/renderer',
  'scripts',
  'tests/integration',
  'packages/shared',
]);
