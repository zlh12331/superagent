// src/renderer/lib/file-search.ts
// 文件名搜索纯函数（glob 模式构造 / 展示用目录派生）
// ──────────────────────────────────────────────────────────────
// 拆分背景（2026-09 file-tree 审计）：以下纯函数原内联在 fuzzy-search-dialog
// 组件内（414 行，glob 构造 + 防抖搜索 + 键盘导航 + 渲染四种职责混居），
// 无法脱离组件渲染直接断言。提到 lib 层后：
// - 无 React 依赖，单测直接覆盖边界（转义 / 大小写展开 / 无分隔符路径）
// - hooks/use-file-glob-search 与组件可共用（hooks 不得反向依赖 components）
// ──────────────────────────────────────────────────────────────

/**
 * glob 特殊字符转义
 *
 * 用户输入里的 `*` `?` `[` `]` `{` `}` `(` `)` `!` 会被 glob 当作模式语法，
 * 转义后按字面量匹配（否则输入 `a*` 会退化成「任意后缀」而非「含 a* 的名字」）。
 */
export function escapeGlob(value: string): string {
  return value.replace(/[*?[\]{}()!]/g, (ch) => `\\${ch}`);
}

/**
 * 每个字母展开为「大小写字符类」，实现 glob 匹配大小写不敏感
 *
 * ripgrep glob 默认大小写敏感，而文件名搜索的既有语义是大小写不敏感
 * （对齐参考项目 fuzzyFileSearch），故在模式层展开而非依赖 rg 参数。
 */
export function toCaseInsensitiveGlob(value: string): string {
  return value.replace(/[a-zA-Z]/g, (ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`);
}

/**
 * 由查询词构造「递归通配 + 子串匹配文件名」的 glob 模式
 *
 * 两步顺序敏感：先转义把用户输入变成字面量，再做大小写展开——
 * 反序会让转义符反斜杠本身也被当作字母处理，破坏转义。
 *
 * @param query 查询词（调用方已 trim；空串不在此拦，由调用方决定不发起搜索）
 * @returns 递归通配前缀 + 展开后的查询词 + 尾部通配 组成的 glob 模式
 */
export function buildFileSearchPattern(query: string): string {
  return `**/*${toCaseInsensitiveGlob(escapeGlob(query))}*`;
}

/**
 * 派生展示用的目录部分（不含文件名），统一转换为正斜杠
 *
 * 仅用于搜索结果的副标题展示，**不是**可回写文件系统的路径：
 * 无分隔符（`a.ts`）与根级文件（`/a.ts`）都返回空串，调用方据此决定是否渲染。
 * 需要可回写的父目录请勿复用本函数（file:watch 的父目录推导是另一套语义，
 * 见 hooks/use-file-tree.ts 的私有 dirname）。
 *
 * @param path 绝对路径（Windows 反斜杠或 POSIX 正斜杠）
 * @returns 目录部分；无目录（根级 / 相对名）返回空串
 */
export function extractDir(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(0, slash) : '';
}
