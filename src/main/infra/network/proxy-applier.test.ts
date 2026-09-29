// src/main/infra/network/proxy-applier.test.ts
// 代理应用单点测试（34 号 §2.7 收口链：mock 断言应用行为，不真设分区）
// ──────────────────────────────────────────────────────────────
// 覆盖：四路径语义（set/import/resetAll/启动共用本函数的参数形态）——
// fixed 应用三分区 + env + resetAIProvider；system 清 env；setProxy 单分区
// 失败不阻断其余分区（反例 7 固定顺序下的韧性）。
// ──────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const setProxy = vi.fn().mockResolvedValue(undefined);
  const makeSession = () => ({ setProxy });
  return { setProxy, makeSession, defaultSession: makeSession() };
});

vi.mock('electron', () => ({
  session: {
    defaultSession: mocks.defaultSession,
    fromPartition: vi.fn(() => mocks.makeSession()),
  },
}));

vi.mock('../ai/llm-client/ai-provider', () => ({
  resetAIProvider: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resetAIProvider } from '../ai/llm-client/ai-provider';
import { applyProxyChange } from './proxy-applier';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setProxy.mockResolvedValue(undefined);
  for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) {
    delete process.env[key];
  }
});

describe('applyProxyChange（四路径统一收口）', () => {
  it('V3 resetAll 语义（raw=undefined）→ 三分区回落 system + env 清空 + 缓存重置', async () => {
    await applyProxyChange(undefined);

    expect(mocks.setProxy).toHaveBeenCalledTimes(3);
    for (const call of mocks.setProxy.mock.calls) {
      expect(call[0]).toEqual({ mode: 'system' });
    }
    expect(process.env['HTTPS_PROXY']).toBeUndefined();
    expect(process.env['http_proxy']).toBeUndefined();
    expect(resetAIProvider).toHaveBeenCalledTimes(1);
  });

  it('V2 fixed → 三分区 fixed_servers + proxyRules + <local> 前置', async () => {
    await applyProxyChange({ mode: 'fixed', url: 'http://127.0.0.1:7890', bypass: ['corp'] });

    expect(mocks.setProxy).toHaveBeenCalledTimes(3);
    expect(mocks.setProxy.mock.calls[0]?.[0]).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'http=127.0.0.1:7890;https=127.0.0.1:7890',
      proxyBypassRules: '<local>;corp',
    });
    // env 侧门（axios 栈）：大小写双写 + NO_PROXY localhost 家族
    expect(process.env['HTTPS_PROXY']).toBe('http://127.0.0.1:7890');
    expect(process.env['https_proxy']).toBe('http://127.0.0.1:7890');
    expect(process.env['NO_PROXY']).toBe('localhost,127.0.0.1,::1');
    expect(resetAIProvider).toHaveBeenCalledTimes(1);
  });

  it('V1 system → 三分区 {mode: system}，env 六键全清（不残留）', async () => {
    process.env['HTTP_PROXY'] = 'http://stale:1';
    process.env['no_proxy'] = 'x';
    await applyProxyChange({ mode: 'system' });

    expect(mocks.setProxy).toHaveBeenCalledTimes(3);
    expect(process.env['HTTP_PROXY']).toBeUndefined();
    expect(process.env['no_proxy']).toBeUndefined();
  });

  it('单分区 setProxy 失败 → warn 不抛，其余分区继续（韧性）', async () => {
    mocks.setProxy.mockRejectedValueOnce(new Error('session destroyed'));
    await expect(applyProxyChange({ mode: 'fixed', url: 'http://p:1' })).resolves.toBeUndefined();
    expect(mocks.setProxy).toHaveBeenCalledTimes(3);
    expect(resetAIProvider).toHaveBeenCalledTimes(1);
  });

  it('损坏值（非对象）→ 按 system 兜底应用（fail-open），不抛', async () => {
    await expect(applyProxyChange('garbage')).resolves.toBeUndefined();
    expect(mocks.setProxy).toHaveBeenCalledTimes(3);
    for (const call of mocks.setProxy.mock.calls) {
      expect(call[0]).toEqual({ mode: 'system' });
    }
  });
});
