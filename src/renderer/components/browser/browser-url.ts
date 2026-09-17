// src/renderer/components/browser/browser-url.ts
// 浏览器预览地址规范化（纯函数，从 browser-pane 外提以便单测边界）
// ──────────────────────────────────────────────────────────────
// 语义：
// - 空白裁剪；空串（含全空白）→ 空串，调用方据此跳过导航
// - 已带 http/https 协议原样保留（协议大小写不敏感）
// - 其余一律补 https:// 前缀——非 http 协议（javascript: / file: 等）
//   因此退化为 https:// 开头的普通地址，不会被当作可执行协议执行
// ──────────────────────────────────────────────────────────────

/** 规范化用户输入的 URL */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}
