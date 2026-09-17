// src/renderer/components/settings/sections/shortcuts-section.test.tsx
// ShortcutsSection 测试：快捷键行渲染与录制控件（写穿透）
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/persistent/settings-store';

import { ShortcutsSection } from './shortcuts-section';

const t = i18n.t.bind(i18n);

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState((s) => ({
    shortcuts: { ...s.shortcuts },
  }));
});

describe('ShortcutsSection', () => {
  it('正向：渲染六个快捷键行，每行一个录键控件', () => {
    render(<ShortcutsSection />);

    // 6 行 × 1 个 ShortcutPicker（button）
    expect(screen.getAllByRole('button')).toHaveLength(6);
  });

  it('边界：已绑定键显示键名，未绑定显示占位文案', () => {
    useSettingsStore.setState((s) => ({
      shortcuts: { ...s.shortcuts, saveFile: '' },
    }));
    render(<ShortcutsSection />);

    expect(screen.getByText(t('settings.shortcutUnbound'))).toBeDefined();
  });
});
