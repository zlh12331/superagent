// src/renderer/components/settings/sections/__tests__/browser-section.test.tsx
// BrowserSection 单测：三项配置渲染 + 交互写穿透到 settings-store.browser
// ──────────────────────────────────────────────────────────────
// 这里锁的是「设置面板改了store、store 落了库」这一段：
// 初值/沙箱是否真被 iframe 消费由 dev/browser-pane 用例覆盖
// （components/dev/__tests__/dev-common-gaps.test.tsx）。
// ──────────────────────────────────────────────────────────────

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applySettingsSnapshot, useSettingsStore } from '@/stores/persistent/settings-store';

import { BrowserSection } from '../browser-section';

function renderSection(): void {
  render(<BrowserSection />);
}

describe('BrowserSection 浏览器设置面板', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applySettingsSnapshot({});
    window.api = { settings: { set: vi.fn(async () => ({ data: { ok: true } })) } } as never;
  });

  it('默认值渲染：自适应预设 / 100% 缩放 / 严格沙箱关闭', () => {
    renderSection();
    expect(screen.getByRole('button', { name: '自适应' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: '100%' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('选择设备预设：写入 defaultDevicePreset 并落库', async () => {
    renderSection();
    await userEvent.click(screen.getByRole('button', { name: '手机' }));
    expect(useSettingsStore.getState().browser.defaultDevicePreset).toBe('mobile');
    expect(window.api.settings.set).toHaveBeenCalledWith({
      key: 'browser',
      value: expect.objectContaining({ defaultDevicePreset: 'mobile' }),
    });
  });

  it('选择缩放档位：写入 defaultZoom', async () => {
    renderSection();
    await userEvent.click(screen.getByRole('button', { name: '75%' }));
    expect(useSettingsStore.getState().browser.defaultZoom).toBe(75);
  });

  it('切换严格沙箱：写入 strictSandbox', async () => {
    renderSection();
    await userEvent.click(screen.getByRole('switch'));
    expect(useSettingsStore.getState().browser.strictSandbox).toBe(true);
  });

  it('回填已有设置：快照值驱动控件初态', () => {
    applySettingsSnapshot({
      browser: { defaultDevicePreset: 'tablet', defaultZoom: 150, strictSandbox: true },
    });
    renderSection();
    expect(screen.getByRole('button', { name: '平板' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '150%' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('不再展示"规划中"占位：配置项已落地', () => {
    renderSection();
    expect(screen.queryByText(/规划中/)).toBeNull();
  });
});
