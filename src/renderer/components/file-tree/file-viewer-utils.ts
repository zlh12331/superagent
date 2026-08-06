// file-viewer-utils.ts（自 FileViewerDialog 拆分）
// 文件预览纯函数（语言检测 / 文件名提取）
// ──────────────────────────────
// 拆分背景：FileViewerDialog 427 行，纯函数与组件混合，按职责提取
import { normalizeLang } from '@/components/chat/Markdown';

const EXT_TO_LANG: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'css',
  md: 'markdown',
  markdown: 'markdown',
  sql: 'sql',
  diff: 'diff',
  patch: 'diff',
};

/**
 * 从文件路径推断 shiki 语言 ID
 *
 * 取最后一个 . 后的扩展名，转小写后查表；未命中时返回 'text'。
 * 无扩展名或未知扩展名 → 'text'（不高亮，但保留 pre 格式）。
 */

export function detectLangFromPath(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1) return 'text';
  const ext = filePath.slice(lastDot + 1).toLowerCase();
  const raw = EXT_TO_LANG[ext] ?? ext;
  return normalizeLang(raw);
}

/**
 * 从绝对路径提取 basename（兼容 Windows 反斜杠与 POSIX 正斜杠）
 */
export function basename(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  const lastBackslash = path.lastIndexOf('\\');
  const idx = Math.max(lastSlash, lastBackslash);
  if (idx === -1) return path;
  return path.slice(idx + 1);
}

/**
 * 文件查看器对话框
 *
 * 全局单例（挂载在 AppShell 根级），通过 useFileViewerStore 控制开关。
 * FileTreePanel 调用 store.openFile(path) 即可弹出本对话框。
 *
 * 双模式切换：
 * - 查看模式（默认）：shiki 高亮只读
 * - 编辑模式：textarea + shiki 叠加高亮，Ctrl+S 保存
 */
