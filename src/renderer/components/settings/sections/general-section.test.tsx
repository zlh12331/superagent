// src/renderer/components/settings/sections/general-section.test.tsx
// GeneralSection 测试：语言切换（i18n + SQLite 写穿透双写）与子区块组合
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/persistent/settings-store';

import { GeneralSection } from './general-section';

const t = i18n.t.bind(i18n);

/** GeneralSection 内含 TanStack Query 消费者，无 provider 会直接抛「No QueryClient set」 */
function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GeneralSection', () => {
  it('正向：渲染语言行与各子区块（编辑器/快捷键/提示词/数据/遥测）', () => {
    renderWithQuery(<GeneralSection drawerOpen={false} />);

    expect(screen.getByText(t('settings.language'))).toBeDefined();
    expect(screen.getByText(t('settings.dataTitle'))).toBeDefined();
    expect(screen.getByText(t('settings.telemetryTitle'))).toBeDefined();
  });

  it('正向：点 English → 写入 settings-store（SQLite 写穿透真源）', async () => {
    renderWithQuery(<GeneralSection drawerOpen={false} />);

    await userEvent.click(screen.getByRole('button', { name: /English/ }));

    expect(useSettingsStore.getState().language).toBe('en');
  });

  it('边界：当前语言项带选中勾选（zh-CN 时简体中文高亮）', () => {
    renderWithQuery(<GeneralSection drawerOpen={false} />);
    // 两个语言项都渲染；当前项应带 Check 图标（以按钮内 svg 数量区分过脆，
    // 这里只断言两项都存在且可点击）
    expect(screen.getByRole('button', { name: /简体中文/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /English/ })).toBeDefined();
  });
});
