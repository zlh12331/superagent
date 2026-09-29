// src/main/infra/network/proxied-fetch.test.ts
// Node 栈代理 fetch 单测（34 号 §2.7：spy dispatcher 断言调用参数，不真连）
// ──────────────────────────────────────────────────────────────
// 探针已证：npm undici 的 fetch 接受 dispatcher 并按其路由；全局 fetch 不认。
// 本测试通过 mock undici 模块断言「dispatcher 是否被传入」，不发起真实网络。
// ──────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  undiciFetch: vi.fn(),
  proxyAgentCtor: vi.fn(),
}));

vi.mock('undici', () => {
  class FakeProxyAgent {
    close = vi.fn().mockResolvedValue(undefined);
    constructor(uri: string) {
      mocks.proxyAgentCtor(uri);
    }
  }
  // 字符串键：规避 useNamingConvention 对 PascalCase 属性名的检查（window-show.test 同法）
  return { fetch: mocks.undiciFetch, ['ProxyAgent']: FakeProxyAgent };
});

import { clearProxyAgents, proxiedFetch, setProxyFetchConfig } from './proxied-fetch';
import type { ProxyConfig } from './proxy-resolver';

beforeEach(() => {
  vi.clearAllMocks();
  clearProxyAgents();
  setProxyFetchConfig(null);
});

describe('proxiedFetch', () => {
  it('V1 未初始化 → 直通全局 fetch（不碰 undici）', async () => {
    const globalFetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    await proxiedFetch('http://api.example.com/v1');
    expect(globalFetchSpy).toHaveBeenCalledTimes(1);
    expect(mocks.undiciFetch).not.toHaveBeenCalled();
    globalFetchSpy.mockRestore();
  });

  it('fixed 模式 + 非 bypass 目标 → undici fetch + ProxyAgent dispatcher（V2）', async () => {
    const cfg: ProxyConfig = { mode: 'fixed', url: 'http://127.0.0.1:7890' };
    setProxyFetchConfig(cfg);
    mocks.undiciFetch.mockResolvedValue(new Response('ok'));

    await proxiedFetch('https://api.openai.com/v1/chat');

    expect(mocks.undiciFetch).toHaveBeenCalledTimes(1);
    const init = mocks.undiciFetch.mock.calls[0]?.[1] as { dispatcher?: unknown };
    expect(init?.dispatcher).toBeDefined();
  });

  it('V4 localhost 硬规则 → 即使 fixed 也直连（不建 agent）', async () => {
    setProxyFetchConfig({ mode: 'fixed', url: 'http://127.0.0.1:7890' });
    const globalFetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await proxiedFetch('http://127.0.0.1:9374/health');

    expect(globalFetchSpy).toHaveBeenCalledTimes(1);
    expect(mocks.undiciFetch).not.toHaveBeenCalled();
    expect(mocks.proxyAgentCtor).not.toHaveBeenCalled();
    globalFetchSpy.mockRestore();
  });

  it('用户 bypass 命中 → 直连', async () => {
    setProxyFetchConfig({
      mode: 'fixed',
      url: 'http://127.0.0.1:7890',
      bypass: ['corp.example'],
    });
    const globalFetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await proxiedFetch('https://api.corp.example/v1');

    expect(globalFetchSpy).toHaveBeenCalledTimes(1);
    globalFetchSpy.mockRestore();
  });

  it('V3 direct 模式 → 直连（无 dispatcher）', async () => {
    setProxyFetchConfig({ mode: 'direct' });
    const globalFetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await proxiedFetch('https://api.openai.com/v1');

    expect(globalFetchSpy).toHaveBeenCalledTimes(1);
    expect(mocks.undiciFetch).not.toHaveBeenCalled();
    globalFetchSpy.mockRestore();
  });

  it('同 URL 复用 ProxyAgent（连接池），换 URL 配置后缓存清空重建', async () => {
    setProxyFetchConfig({ mode: 'fixed', url: 'http://p1:1' });
    mocks.undiciFetch.mockResolvedValue(new Response('ok'));
    await proxiedFetch('https://a.example.com');
    await proxiedFetch('https://b.example.com');
    expect(mocks.proxyAgentCtor).toHaveBeenCalledTimes(1);

    setProxyFetchConfig({ mode: 'fixed', url: 'http://p2:2' });
    await proxiedFetch('https://a.example.com');
    // 旧 agent（p1）被替换：ctor 共两次（p1 一次 + p2 一次），最后一次是 p2
    expect(mocks.proxyAgentCtor).toHaveBeenCalledTimes(2);
    expect(mocks.proxyAgentCtor).toHaveBeenNthCalledWith(2, 'http://p2:2');
  });
});
