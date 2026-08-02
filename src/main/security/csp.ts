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
 * - connect-src：仅允许 AI API（DeepSeek / OpenAI / Anthropic）+ 本地 Ollama，
 *   与 ProviderRegistry 内置供应商对齐（新增供应商时需同步此列表）
 * - object-src 'none' / frame-ancestors 'none'：禁用插件与嵌入
 * - worker-src：shiki 高亮等 Web Worker 场景（与 dev 对齐）
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self' https://api.deepseek.com https://api.openai.com https://api.anthropic.com http://localhost:*",
  "img-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

/**
 * 开发环境 CSP 指令
 *
 * 在生产 CSP 基础上额外放开：
 * - script-src 增加 'unsafe-inline'：@vitejs/plugin-react 需要注入 inline script
 *   实现 React Fast Refresh preamble，不放开会被 CSP 拦截导致 React 无法启动
 * - connect-src 增加 ws://localhost:* http://localhost:*（Vite HMR WebSocket + dev server fetch）
 * - frame-ancestors 放开 'self' 与 chrome-extension:// scheme：
 *   React DevTools 扩展（chrome-extension://<id>/main.html）需要在 DevTools 面板的 iframe 中加载
 *   'none' 会触发 ERR_BLOCKED_BY_RESPONSE 导致 Components/Profiler 面板无法打开
 *   仅 dev 环境放开，生产环境仍保持 'none'
 * - 不放开 'unsafe-eval'：Vite 8 使用原生 ESM，无需 eval
 */
const DEVELOPMENT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self' http://localhost:* ws://localhost:* https://api.deepseek.com https://api.openai.com",
  "img-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self' chrome-extension: http://localhost:5173 http://localhost:5174",
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
