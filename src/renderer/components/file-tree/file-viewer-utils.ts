// file-viewer-utils.ts（自文件预览组件拆分，纯函数集；源组件现名 FileViewerPanel）
// 文件预览纯函数（shiki 语言检测 / 行数计算）
// ──────────────────────────────
// 拆分背景：源组件 427 行（拆分时名 FileViewerDialog），纯函数与组件混合，按职责提取
import { normalizeLang } from '@/lib/highlight';
import { fileExtension } from '@/lib/utils';

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
 * 取扩展名（单一真源 lib/utils.fileExtension），查表后交 normalizeLang 规范化；
 * 未命中时把扩展名原样交给 normalizeLang（受支持语言可直通，如 toml），
 * 最终未知一律回落 'text'（不高亮，但保留 pre 格式）。
 */

export function detectLangFromPath(filePath: string): string {
  const ext = fileExtension(filePath);
  if (ext === '') return 'text';
  return normalizeLang(EXT_TO_LANG[ext] ?? ext);
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
