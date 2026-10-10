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
 * - connect-src 'self'（2026-09-28 收口，完成 2026-09-13 挂账）：渲染层实测零
 *   直连网络请求——AI 调用全部在主进程（llm-client），错误上报已于同日移除
 *   Sentry 改为本地日志。此前放行的 AI API 域名与 Ollama 端口均为自认「死重」，
 *   等于给被 XSS 的渲染层保留外渗面（token/对话内容可发往已放行域名）；
 *   收敛依据 = 生产构建 smoke 全绿 + 渲染层交互无网络错误（csp.test 断言）。
 *   Ollama 自定义端口走 OLLAMA_API_BASE（主进程消费，不经渲染层）。
 * - object-src 'none' / frame-ancestors 'none'：禁用插件与嵌入
 * - worker-src：shiki 高亮等 Web Worker 场景（与 dev 对齐)
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' 'sha256-8jqBLHilVf+0piQNUM57HQvi2M+INQgFJXoQsMx2EzE='",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self'",
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
  "connect-src 'self' http://localhost:* ws://localhost:*",
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
    if (details.url.startsWith('chrome-extension://')) {
      callback({});
      return;
    }

    const headers: Record<string, string[]> = {
      ...details.responseHeaders,
      'Content-Security-Policy': [csp],
      'X-Content-Type-Options': ['nosniff'],
    };

    if (details.url.startsWith('http')) {
      headers['X-Frame-Options'] = [isProduction ? 'DENY' : 'SAMEORIGIN'];
    }

    callback({ responseHeaders: headers });
  });
}
