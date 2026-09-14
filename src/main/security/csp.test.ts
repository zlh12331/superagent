// src/main/security/csp.test.ts
// CSP 策略构建器单测：生产/开发两套策略的关键指令

import { describe, expect, it } from 'vitest';

import { buildCsp } from './csp';

describe('buildCsp', () => {
  it('生产环境：严格策略（script-src 无 unsafe-inline）', () => {
    const csp = buildCsp(false);
    // script-src 不放开内联脚本（style-src 的 unsafe-inline 是 React/Tailwind 所需，保留）
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    // shiki WASM 高亮必需（不放 JS eval）
    expect(csp).toContain('wasm-unsafe-eval');
    expect(csp).not.toContain("'unsafe-eval'");
    // 禁止插件与嵌入
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // AI API 域名（多供应商对齐）
    expect(csp).toContain('https://api.deepseek.com');
    expect(csp).toContain('https://api.openai.com');
    expect(csp).toContain('https://api.anthropic.com');
    // 本地 Ollama 精确端口（2026-09-13 收口：localhost:* → 11434，
    // 消除被 XSS 的渲染层访问本机任意端口的内网探测面）
    expect(csp).toContain('http://localhost:11434');
    expect(csp).not.toContain('http://localhost:*');
  });

  it('开发环境：允许 HMR（unsafe-inline script + localhost ws/http）', () => {
    const csp = buildCsp(true);
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    // dev 同样放开 WASM（shiki 高亮）
    expect(csp).toContain('wasm-unsafe-eval');
    expect(csp).toContain('ws://localhost:*');
    expect(csp).toContain('http://localhost:*');
    // 开发环境 frame-ancestors 放开（DevTools 扩展）
    expect(csp).toContain("frame-ancestors 'self' chrome-extension:");
  });

  it('生产 CSP 不含 worker 限制缺失（worker-src 存在）', () => {
    const csp = buildCsp(false);
    expect(csp).toContain("worker-src 'self' blob:");
  });

  it('指令以分号连接且 default-src 为首', () => {
    const csp = buildCsp(false);
    const directives = csp.split('; ');
    expect(directives[0]).toBe("default-src 'self'");
    expect(directives.length).toBeGreaterThan(8);
  });
});
