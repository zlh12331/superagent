// sidebar-utils.ts（自 Sidebar 拆分）
// 侧边栏纯函数
// ──────────────────────────────
// 拆分背景：Sidebar 641 行，纯函数与组件混合，按职责提取
// ──────────────────────────────

export function getFolderName(workingDir: string): string {
  const basename = workingDir.split(/[\\/]/).pop();
  return basename && basename.length > 0 ? basename : '';
}
