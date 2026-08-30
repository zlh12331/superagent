// vitest.workspace.ts
// VS Code Vitest Explorer 多配置聚合
// 参考: https://vitest.dev/guide/workspace
// 注：Vitest 4 移除 defineWorkspace API，工作区文件改为直接导出路径数组
// （knip 同样按此格式加载）

// biome-ignore lint/style/noDefaultExport: vitest workspace 要求 export default
export default [
  'src/main',
  'src/main/vitest.perf.config.ts',
  'src/renderer',
  'scripts',
  'tests/integration',
  'packages/shared',
];
