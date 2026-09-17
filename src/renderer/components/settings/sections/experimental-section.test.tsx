// src/renderer/components/settings/sections/experimental-section.test.tsx
// ExperimentalSection 测试：实验开关写 store（只列已接入消费方的开关）
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/persistent/settings-store';

import { ExperimentalSection } from './experimental-section';

const t = i18n.t.bind(i18n);

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({
    experimental: { scanlines: false, reasoningCollapsed: false, autoCompact: false },
  });
});

describe('ExperimentalSection', () => {
  it('正向：切换 scanlines 开关 → 写入 store', async () => {
    render(<ExperimentalSection />);

    await userEvent.click(
      screen.getByRole('switch', { name: t('settings.experimental.scanlines') }),
    );

    expect(useSettingsStore.getState().experimental.scanlines).toBe(true);
  });

  it('正向：三个实验开关均渲染（诚实原则：只列已接入消费方的开关）', () => {
    render(<ExperimentalSection />);

    expect(
      screen.getByRole('switch', { name: t('settings.experimental.scanlines') }),
    ).toBeDefined();
    expect(
      screen.getByRole('switch', { name: t('settings.experimental.reasoningCollapsed') }),
    ).toBeDefined();
    expect(
      screen.getByRole('switch', { name: t('settings.experimental.autoCompact') }),
    ).toBeDefined();
  });
});
