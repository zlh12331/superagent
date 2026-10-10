import type { Session } from 'electron';

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

export function buildCsp(isDev: boolean): string {
  return isDev ? DEVELOPMENT_CSP : PRODUCTION_CSP;
}

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
