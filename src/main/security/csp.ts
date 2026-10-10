// csp.ts：主进程对 defaultSession 统一注入 CSP/X-Content-Type-Options/X-Frame-Options
// ⚠️ 产线 script-src 的 'sha256-…' 是内联脚本哈希锚定（check:csp-hash 卡关）：改 CSP 或内联脚本须同步重算
import type { Session } from 'electron';

// 产线策略：脚本只认自身 + wasm + 一个内联哈希；style 须 unsafe-inline（React inline style 注入不了 script，
// 代价可接受）；frame-ancestors 'none' 防被外部页面嵌套
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

// dev 策略放宽：unsafe-inline（vite HMR 注入）、localhost connect/ws、扩展框架嵌套（React DevTools）
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

/** 按环境构建 CSP 串（prod/dev 两套常量，勿动态拼接——哈希锚定要求字面稳定） */
export function buildCsp(isDev: boolean): string {
  return isDev ? DEVELOPMENT_CSP : PRODUCTION_CSP;
}

/**
 * 给 session 挂响应头注入：所有响应盖 CSP + nosniff；http(s) 响应再盖 X-Frame-Options
 * （产线 DENY / dev SAMEORIGIN）——这是「网页预览绝不走渲染层 iframe」三层拦截的第二层
 *
 * chrome-extension:// 响应跳过（DevTools 扩展自带响应头，覆盖会破坏其加载）
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
