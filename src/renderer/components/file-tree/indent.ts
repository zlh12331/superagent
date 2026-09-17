// src/renderer/components/file-tree/indent.ts
// 文件树缩进计算（FileTreeNode 与 InlineCreateInput 共用）
// ──────────────────────────────────────────────────────────────
// 收敛动机（2026-09 审计）：每层缩进公式（depth*12+8）此前在两个组件里
// 各写一份字面量，改缩进口径需同步两处。抽出为单一真源。
// ──────────────────────────────────────────────────────────────

/** 每层缩进（px），对齐 VS Code 风格 */
const INDENT_PER_DEPTH = 12;

/** 按深度生成缩进内联样式（depth 从 0 起，根节点为 0） */
export function indentStyle(depth: number): { paddingLeft: string } {
  return { paddingLeft: `${depth * INDENT_PER_DEPTH + 8}px` };
}
