// src/main/security/csp.ts
// Content Security Policy 策略构建器（P1-5 安全基线）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 根据 app.isPackaged 构建生产 / 开发两套 CSP 字符串
// - 生产环境：严格 CSP，仅允许 self + Google Fonts + AI API 域名
// - 开发环境：在严格 CSP 基础上额外放开 Vite HMR（ws/http localhost）
//
// 注入方式：
// - 通过 session.defaultSession.webRequest.onHeadersReceived 注入响应头
// - 渲染层 HTML 保留 CSP meta 作为纵深防御兜底（onHeadersReceived 未拦截时生效）
//
// 参考：
// - Electron Security Checklist: https://www.electronjs.org/docs/latest/tutorial/security
// - CSP Level 3: https://www.w3.org/TR/CSP3/
// ──────────────────────────────────────────────────────────────

/**
 * 生产环境 CSP 指令
 *
 * 严格策略：
 * - default-src 'self'：默认仅允许同源
 * - script-src 'self'：禁止内联脚本与外部脚本
 * - style-src 'unsafe-inline'：React 19 + Tailwind v4 运行时注入内联样式，必须放开
 * - connect-src：仅允许 AI API（DeepSeek / OpenAI）同源连接
 * - object-src 'none' / frame-ancestors 'none'：禁用插件与嵌入
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self' https://api.deepseek.com https://api.openai.com",
  "img-src 'self' data: blob:",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

/**
 * 开发环境 CSP 指令
 *
 * 在生产 CSP 基础上额外放开：
 * - script-src 不变（'self' 已覆盖 Vite dev server 同源）
 * - connect-src 增加 ws://localhost:* http://localhost:*（Vite HMR WebSocket + dev server fetch）
 * - 不放开 'unsafe-eval'：Vite 8 使用原生 ESM，无需 eval
 */
const DEVELOPMENT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self' http://localhost:* ws://localhost:* https://api.deepseek.com https://api.openai.com",
  "img-src 'self' data: blob:",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

/**
 * 构建 CSP 字符串
 *
 * @param isDev - 是否开发环境（true 时使用宽松策略，false 时使用严格策略）
 * @returns CSP 指令字符串（分号分隔）
 */
export function buildCsp(isDev: boolean): string {
  return isDev ? DEVELOPMENT_CSP : PRODUCTION_CSP;
}
