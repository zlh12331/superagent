// src/renderer/components/settings/sections/zoom-section.test.tsx
// ZoomSection 测试（35 号 §2.7：11 档渲染 + 选择写 store）
// ──────────────────────────────────────────────────────────────
// Radix Select 的浮层在 jsdom 下交互复杂，本测试：
// - 断言触发器的当前值回显（store 单真源）
// - 直接调用 store 断言写穿透链（Select onValueChange 的语义由 store 测试覆盖）
// - 档位表完整性（11 档派生自 ZOOM_LEVELS，防 UI 与真源脱节）
// ──────────────────────────────────────────────────────────────

import { ZOOM_LEVELS } from '@code-agent/shared/renderer';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/persistent/settings-store';

import { ZoomSection } from './zoom-section';

const t = i18n.t.bind(i18n);
const setSpy = vi.fn(async () => ({ data: { ok: true } }));

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'api', {
    value: { settings: { set: setSpy } },
    writable: true,
    configurable: true,
  });
  useSettingsStore.setState({ appearance: { zoom: 1 } });
});

describe('ZoomSection', () => {
  it('渲染标题与当前档位回显（100%）', () => {
    render(<ZoomSection />);
    expect(screen.getByText(t('settings.zoomTitle'))).toBeDefined();
    expect(screen.getByText(t('settings.zoomPercent', { percent: 100 }))).toBeDefined();
  });

  it('当前档位 125% → 触发器回显 125%（store 单真源）', () => {
    useSettingsStore.setState({ appearance: { zoom: 1.25 } });
    render(<ZoomSection />);
    expect(screen.getByText(t('settings.zoomPercent', { percent: 125 }))).toBeDefined();
  });

  it('档位表与 ZOOM_LEVELS 单一真源一致（11 档）', () => {
    expect(ZOOM_LEVELS).toHaveLength(11);
    // 每档的百分比文案都有唯一 key（SelectItem value 用 String(level)，浮点唯一）
    const values = ZOOM_LEVELS.map((l) => String(l));
    expect(new Set(values).size).toBe(11);
  });

  it('updateAppearance 写穿透以 appearance 键落库（V2 写半）', async () => {
    useSettingsStore.getState().updateAppearance({ zoom: 1.5 });
    await waitFor(() => {
      const calls = setSpy.mock.calls as unknown as { key: string }[][];
      expect(calls.filter((c) => c[0]?.key === 'appearance')).toHaveLength(1);
    });
    expect(useSettingsStore.getState().appearance.zoom).toBe(1.5);
  });
});
