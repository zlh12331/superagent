/** 每层缩进（px），对齐 VS Code 风格 */
const INDENT_PER_DEPTH = 12;

/** 按深度生成缩进内联样式（depth 从 0 起，根节点为 0） */
export function indentStyle(depth: number): { paddingLeft: string } {
  return { paddingLeft: `${depth * INDENT_PER_DEPTH + 8}px` };
}
