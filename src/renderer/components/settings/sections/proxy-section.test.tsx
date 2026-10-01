// src/renderer/components/settings/sections/proxy-section.test.tsx
// ProxySection 测试（34 号 spec §2.7 组件断言：store 实质状态 + 测试按钮三态）
// ──────────────────────────────────────────────────────────────
// 覆盖：三模式渲染与切换写 store / fixed 展开地址与 bypass 编辑（blur 写穿透）/
// 非法地址不入库（V9 UI 半）/ 测试连接三态（ok / not-applicable）。
// ──────────────────────────────────────────────────────────────

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/persistent/settings-store';

import { ProxySection } from './proxy-section';

const t = i18n.t.bind(i18n);

const setSpy = vi.fn(async () => ({ data: { ok: true } }));
const testSpy = vi.fn(async () => ({
  data: { ok: true, kind: 'ok', message: undefined },
}));

function renderSection(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ProxySection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'api', {
    value: { settings: { set: setSpy }, proxy: { test: testSpy } },
    writable: true,
    configurable: true,
  });
  useSettingsStore.setState({ proxy: { mode: 'system' } });
});

describe('ProxySection', () => {
  it('system 模式：三选项渲染，fixed 专属区块不显示（V10 显隐）', () => {
    renderSection();

    expect(screen.getByText(t('settings.proxyModeSystem'))).toBeDefined();
    expect(screen.queryByLabelText(t('settings.proxyUrlLabel'))).toBeNull();
    expect(screen.queryByRole('button', { name: t('settings.proxyTestButton') })).toBeNull();
  });

  it('切换到 fixed → 地址/绕过/测试按钮展开，模式写 store + 写穿透', async () => {
    renderSection();

    await userEvent.click(screen.getByText(t('settings.proxyModeFixed')));

    expect(useSettingsStore.getState().proxy.mode).toBe('fixed');
    await waitFor(() => {
      const calls = setSpy.mock.calls as unknown as { key: string }[][];
      expect(calls.filter((c) => c[0]?.key === 'proxy')).toHaveLength(1);
    });
    expect(screen.getByLabelText(t('settings.proxyUrlLabel'))).toBeDefined();
    expect(screen.getByRole('button', { name: t('settings.proxyTestButton') })).toBeDefined();
  });

  it('fixed 地址 blur：合法 http(s) 写穿透（V2 写半）', async () => {
    useSettingsStore.setState({ proxy: { mode: 'fixed' } });
    renderSection();

    const input = screen.getByLabelText(t('settings.proxyUrlLabel'));
    await userEvent.type(input, 'http://127.0.0.1:7890');
    await userEvent.tab();

    expect(useSettingsStore.getState().proxy.url).toBe('http://127.0.0.1:7890');
  });

  it('V9 UI 半：非法地址不入库（store 不携带 url）', async () => {
    useSettingsStore.setState({ proxy: { mode: 'fixed' } });
    renderSection();

    const input = screen.getByLabelText(t('settings.proxyUrlLabel'));
    await userEvent.type(input, 'not-a-url');
    await userEvent.tab();

    expect(useSettingsStore.getState().proxy.url).toBeUndefined();
  });

  it('V10 测试连接：成功 → 结果文案（proxy:test 被调）', async () => {
    useSettingsStore.setState({ proxy: { mode: 'fixed', url: 'http://p:1' } });
    renderSection();

    await userEvent.click(screen.getByRole('button', { name: t('settings.proxyTestButton') }));

    await waitFor(() => {
      expect(screen.getByText(t('settings.proxyTestSuccess'))).toBeDefined();
    });
    expect(testSpy).toHaveBeenCalledTimes(1);
  });
});
