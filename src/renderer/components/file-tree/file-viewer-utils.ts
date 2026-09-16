// file-viewer-utils.ts（自文件预览组件拆分，纯函数集；源组件现名 FileViewerPanel）
// 文件预览纯函数（shiki 语言检测 / 行数计算）
// ──────────────────────────────
// 拆分背景：源组件 427 行（拆分时名 FileViewerDialog），纯函数与组件混合，按职责提取
import { normalizeLang } from '@/lib/highlight';

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
 * 内容行数（按换行切分的段数；空串视为 0 行而非 1 行空行）
 *
 * 用于查看态无 IPC totalLines 时的回退计算，以及编辑态行数的实时显示。
 */
export function lineCount(content: string): number {
  return content === '' ? 0 : content.split('\n').length;
}

// basename 已收敛至 @/lib/utils（渲染层此前 4 份重复实现合一）
