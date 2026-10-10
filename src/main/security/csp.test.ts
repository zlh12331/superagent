import { describe, expect, it } from 'vitest';

import { buildCsp } from './csp';

describe('buildCsp', () => {
  it('生产环境：严格策略（script-src 无 unsafe-inline）', () => {
    const csp = buildCsp(false);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain('wasm-unsafe-eval');
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('api.deepseek.com');
    expect(csp).not.toContain('api.openai.com');
    expect(csp).not.toContain('api.anthropic.com');
    expect(csp).not.toContain('http://localhost:11434');
    expect(csp).not.toContain('http://localhost:*');
  });

  it('开发环境：允许 HMR（unsafe-inline script + localhost ws/http）', () => {
    const csp = buildCsp(true);
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain('wasm-unsafe-eval');
    expect(csp).toContain('ws://localhost:*');
    expect(csp).toContain('http://localhost:*');
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
