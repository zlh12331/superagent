// src/main/infra/network/proxy-resolver.test.ts
// 代理配置解析器单测（34 号网络代理；docs/design/34-network-proxy-spec.md §2.7）
// ──────────────────────────────────────────────────────────────
// 覆盖：三模式归一化 / 缺失损坏回 system（fail-open）/ localhost 恒绕过 /
// bypass 匹配 / URL 内嵌凭据脱敏 / 非法协议拒绝。
// ──────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  buildChromiumProxyConfig,
  buildProxyUrl,
  maskProxyUrl,
  parseProxyConfig,
  shouldBypass,
} from './proxy-resolver';

describe('parseProxyConfig', () => {
  it('V1 缺失（undefined）→ mode=system（fail-open 向既有行为）', () => {
    expect(parseProxyConfig(undefined)).toEqual({ mode: 'system' });
  });

  it('损坏（非对象 / 字符串 / 数组）→ mode=system + warn 一次', () => {
    expect(parseProxyConfig('garbage')).toEqual({ mode: 'system' });
    expect(parseProxyConfig(42)).toEqual({ mode: 'system' });
    expect(parseProxyConfig(['fixed'])).toEqual({ mode: 'system' });
  });

  it('合法 fixed → 保留 url 与 bypass', () => {
    expect(
      parseProxyConfig({ mode: 'fixed', url: 'http://127.0.0.1:7890', bypass: ['corp.example'] }),
    ).toEqual({ mode: 'fixed', url: 'http://127.0.0.1:7890', bypass: ['corp.example'] });
  });

  it('字段非法（mode 未知 / url 非法协议 / bypass 非数组）→ 整体回 system（fail-open）', () => {
    expect(parseProxyConfig({ mode: 'quick' })).toEqual({ mode: 'system' });
    expect(parseProxyConfig({ mode: 'fixed', url: 'ftp://x' })).toEqual({ mode: 'system' });
    expect(parseProxyConfig({ mode: 'fixed', url: 'not-a-url' })).toEqual({ mode: 'system' });
    expect(parseProxyConfig({ mode: 'fixed', url: 'http://p:1', bypass: 'x' })).toEqual({
      mode: 'system',
    });
  });
});

describe('buildChromiumProxyConfig', () => {
  it('system → {mode: system}', () => {
    expect(buildChromiumProxyConfig({ mode: 'system' })).toEqual({ mode: 'system' });
  });

  it('V3 direct → {mode: direct}（强制直连）', () => {
    expect(buildChromiumProxyConfig({ mode: 'direct' })).toEqual({ mode: 'direct' });
  });

  it('fixed → fixed_servers + proxyRules + 强制 <local> bypass（反例 2）', () => {
    const cfg = buildChromiumProxyConfig({
      mode: 'fixed',
      url: 'http://127.0.0.1:7890',
      bypass: ['corp.example'],
    });
    expect(cfg).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'http=127.0.0.1:7890;https=127.0.0.1:7890',
      proxyBypassRules: '<local>;corp.example',
    });
  });

  it('fixed 但 url 缺失（防御）→ 回 system 映射', () => {
    expect(buildChromiumProxyConfig({ mode: 'fixed' })).toEqual({ mode: 'system' });
  });
});

describe('buildProxyUrl', () => {
  it('fixed → http 代理 URL（undici ProxyAgent / env 侧门共用）', () => {
    expect(buildProxyUrl({ mode: 'fixed', url: 'http://127.0.0.1:7890' })).toBe(
      'http://127.0.0.1:7890',
    );
  });

  it('带认证的 fixed → 保留凭据（D5：Node 栈原生支持）', () => {
    expect(buildProxyUrl({ mode: 'fixed', url: 'http://user:pass@10.0.0.1:8080' })).toBe(
      'http://user:pass@10.0.0.1:8080',
    );
  });

  it('system/direct → undefined', () => {
    expect(buildProxyUrl({ mode: 'system' })).toBeUndefined();
    expect(buildProxyUrl({ mode: 'direct' })).toBeUndefined();
  });
});

describe('shouldBypass', () => {
  it('V4 localhost 家族恒绕过（硬规则，反例 2）', () => {
    for (const url of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:9374/health',
      'http://[::1]:8080/x',
    ]) {
      expect(shouldBypass({ mode: 'fixed', url: 'http://p:1' }, url)).toBe(true);
    }
  });

  it('用户 bypass：主机后缀匹配', () => {
    const cfg = { mode: 'fixed' as const, url: 'http://p:1', bypass: ['corp.example'] };
    expect(shouldBypass(cfg, 'http://api.corp.example/v1')).toBe(true);
    expect(shouldBypass(cfg, 'http://corp.example:8080/x')).toBe(true);
    expect(shouldBypass(cfg, 'http://evil-corp.example.com/')).toBe(false);
    expect(shouldBypass(cfg, 'https://api.openai.com/v1')).toBe(false);
  });

  it('非 fixed 模式恒 false（无需绕过判断）', () => {
    expect(shouldBypass({ mode: 'system' }, 'http://localhost:1')).toBe(false);
  });
});

describe('maskProxyUrl（安全：凭据不落日志）', () => {
  beforeEach(() => {
    // 无共享状态，占位
  });

  it('带凭据 URL 脱敏', () => {
    expect(maskProxyUrl('http://user:pass@10.0.0.1:8080')).toBe('http://***@10.0.0.1:8080');
  });

  it('无凭据 URL 原样', () => {
    expect(maskProxyUrl('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
  });

  it('非法 URL 原样返回（不抛）', () => {
    expect(maskProxyUrl('not-a-url')).toBe('not-a-url');
  });
});
