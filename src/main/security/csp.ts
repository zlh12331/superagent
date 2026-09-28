// src/main/security/csp.ts
// Content Security Policy 策略构建器（P1-5 安全基线）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 根据 app.isPackaged 构建生产 / 开发两套 CSP 字符串
// - 生产环境：严格 CSP，仅允许 self + Google Fonts + AI API 域名
// - 开发环境：在严格 CSP 基础上额外放开 Vite HMR（ws/http localhost）
// - applyCspToSession：唯一注入入口（CSP/nosniff/X-Frame-Options 三头一并）
//
// 注入方式：
// - 唯一执行点 = applyCspToSession（经 session.webRequest.onHeadersReceived 注入响应头）
// - 渲染层 HTML 刻意不含 CSP meta（2026-09-28 修正：此前本注释谎称"HTML 保留
//   meta 兜底"，实际不存在——meta 不支持 frame-ancestors，且会与响应头形成
//   双真源漂移；check:csp-hash 现断言 index.html 无 meta）
//
// ⚠️ 作用域边界：本策略只覆盖 defaultSession。右面板「浏览器」预览走
// WebContentsView + 独立内存分区 'browser-preview'（src/main/infra/browser/
// preview-service.ts），刻意不在本注入作用域内——若把预览页放进 defaultSession
// （如改回 iframe），会被下方策略三层拦截（无 frame-src 回退 default-src 'self'
// + onHeadersReceived 给远端响应注入 X-Frame-Options/CSP），生产环境无法加载
// 任何真实网页（2026-09-12 已实测并以此重构）。
//
// 参考：
// - Electron Security Checklist: https://www.electronjs.org/docs/latest/tutorial/security
// - CSP Level 3: https://www.w3.org/TR/CSP3/
// ──────────────────────────────────────────────────────────────

import type { Session } from 'electron';

/**
 * 生产环境 CSP 指令
 *
 * 严格策略：
 * - default-src 'self'：默认仅允许同源
 * - script-src 'self' 'wasm-unsafe-eval' + 首帧主题脚本 hash：禁止内联/外部脚本，
 *   但放开 WebAssembly 编译（shiki 语法高亮的 WASM 引擎必需；'wasm-unsafe-eval'
 *   是 CSP3 专用关键字，不放开 JS eval，比 'unsafe-eval' 面窄——实测缺它所有
 *   代码高亮静默失效）。
 *   'sha256-8jqBLHilVf+0piQNUM57HQvi2M+INQgFJXoQsMx2EzE='：index.html head 的
 *   首帧防闪内联脚本（读 localStorage 主题镜像切 .dark，见 index.html 头部注释）。
 *   ⚠️ 修改该脚本任何字符必须重算 sha256 并同步此处，否则脚本被 CSP 拦截、
 *   防闪失效（表现为暗色用户首帧亮→暗闪）。2026-09-11 因 catch 绑定去冗余
 *   （`catch(_e)` → `catch`，noUselessCatchBinding 规则）重算过一次。
 * - style-src 'unsafe-inline'：React 19 + Tailwind v4 运行时注入内联样式，必须放开
 * - connect-src：仅允许 AI API（DeepSeek / OpenAI / Anthropic）+ 本地 Ollama 默认
 *   端口，与 ProviderRegistry 内置供应商对齐（新增供应商时需同步此列表）。
 *   2026-09-13 收口：localhost:* → localhost:11434——渲染层实测零直连网络
 *   请求（AI 调用全部在主进程，错误上报已于同日移除 Sentry 改为本地日志），
 *   放行任意
 *   本机端口等于给被 XSS 的渲染层开放内网探测面；Ollama 自定义端口走
 *   OLLAMA_API_BASE（主进程消费，不经渲染层，不受此约束）。
 *   注：AI API 域名与 11434 同为死重，收敛到 connect-src 'self' 需 prod
 *   smoke 实测后再做（曾因保守仅精确化端口）。
 * - object-src 'none' / frame-ancestors 'none'：禁用插件与嵌入
 * - worker-src：shiki 高亮等 Web Worker 场景（与 dev 对齐）
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' 'sha256-8jqBLHilVf+0piQNUM57HQvi2M+INQgFJXoQsMx2EzE='",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self' https://api.deepseek.com https://api.openai.com https://api.anthropic.com http://localhost:11434",
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
 * - script-src 增加 'wasm-unsafe-eval'：shiki 语法高亮 WASM 引擎（与生产一致，
 *   实测缺失时消息/文件查看器的代码高亮全部静默降级为纯文本）
 */
const DEVELOPMENT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
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

/**
 * 向指定 session 注入安全响应头（CSP / nosniff / X-Frame-Options）——唯一注入入口
 *
 * 唯一执行点原则：渲染层 HTML 刻意不含 CSP meta（meta 不支持 frame-ancestors，
 * 且会与响应头形成双真源漂移），全部安全头经本函数的 onHeadersReceived 注入。
 * 新增任何 session 分区（未来的多窗口/隔离分区）时必须复用本函数，不得自行
 * 内联注册 onHeadersReceived——check:csp-hash 同时断言 index.html 无 meta，
 * 防止"补"出 meta 造成双真源。
 *
 * @param session 要注入的 session（主窗口用 defaultSession）
 * @param isDev 是否开发环境（true 时使用宽松策略：Vite HMR + DevTools iframe）
 */
export function applyCspToSession(session: Session, isDev: boolean): void {
  const csp = buildCsp(isDev);
  const isProduction = !isDev;
  session.webRequest.onHeadersReceived((details, callback) => {
    // 跳过 chrome-extension:// 协议的响应
    // 原因：dev 环境 React DevTools 扩展（chrome-extension://<id>/main.html）的
    // 内部资源加载策略由扩展自身 manifest.content_security_policy 控制，
    // 主进程注入的 CSP 会与扩展策略冲突，触发 ERR_BLOCKED_BY_RESPONSE 导致
    // Components/Profiler 面板无法加载。
    // 安全性：chrome-extension:// 协议的响应头由 Chrome Web Store 签名验证，
    // 不需要主进程额外注入安全头。
    if (details.url.startsWith('chrome-extension://')) {
      callback({});
      return;
    }

    const headers: Record<string, string[]> = {
      ...details.responseHeaders,
      'Content-Security-Policy': [csp],
      // X-Content-Type-Options: nosniff — 防止 MIME 类型嗅探
      // 阻止浏览器将非脚本资源解释为可执行脚本（防 XSS via MIME 混淆）
      // 参考：https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Content-Type-Options
      'X-Content-Type-Options': ['nosniff'],
    };

    // X-Frame-Options: 仅对 http(s) 协议注入
    // - 生产环境 DENY：完全禁止嵌入（最严格）
    // - 开发环境 SAMEORIGIN：允许同源嵌入（DevTools 面板用 chrome-extension:// 协议已被上面跳过）
    // CSP frame-ancestors 是更现代的替代方案，此头作为旧浏览器兜底
    // 参考：https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Frame-Options
    if (details.url.startsWith('http')) {
      headers['X-Frame-Options'] = [isProduction ? 'DENY' : 'SAMEORIGIN'];
    }

    callback({ responseHeaders: headers });
  });
}
