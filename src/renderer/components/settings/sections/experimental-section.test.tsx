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
    experimental: { reasoningCollapsed: false, autoCompact: false },
  });
});

describe('ExperimentalSection', () => {
  it('正向：切换 reasoningCollapsed 开关 → 写入 store', async () => {
    render(<ExperimentalSection />);

    await userEvent.click(
      screen.getByRole('switch', { name: t('settings.experimental.reasoningCollapsed') }),
    );

    expect(useSettingsStore.getState().experimental.reasoningCollapsed).toBe(true);
  });

  it('正向：实验开关均渲染（诚实原则：只列已接入消费方的开关）', () => {
    render(<ExperimentalSection />);

    expect(
      screen.getByRole('switch', { name: t('settings.experimental.reasoningCollapsed') }),
    ).toBeDefined();
    expect(
      screen.getByRole('switch', { name: t('settings.experimental.autoCompact') }),
    ).toBeDefined();
  });
});
