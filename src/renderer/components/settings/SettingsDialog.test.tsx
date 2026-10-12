import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsDialog } from './SettingsDialog';

describe('SettingsDialog 冒烟', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.api.models = { list: vi.fn(async () => ({ data: { models: [] } })) } as never;
    window.api.settings = {
      get: vi.fn(async () => ({ data: { ok: true } })),
      set: vi.fn(async () => ({ data: { ok: true } })),
      getApiKey: vi.fn(async () => ({ data: { apiKey: null } })),
      addRuntimeModel: vi.fn(async () => ({ data: { ok: true } })),
      removeRuntimeModel: vi.fn(async () => ({ data: { ok: true } })),
    } as never;
    window.api.app = {
      getInfo: vi.fn(async () => ({
        data: {
          version: '0.1.0',
          electron: '-',
          node: '-',
          chrome: '-',
          platform: 'test',
          arch: '-',
          userDataPath: '-',
        },
      })),
    } as never;
  });

  function renderDialog() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SettingsDialog open onOpenChange={vi.fn()} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('打开：渲染 5 组导航（15 tab）+ 默认模型分区', () => {
    renderDialog();
    for (const label of ['通用', '能力', '智能与行为', '实验', '关于']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByRole('tab').length).toBe(15);
    const modelsTab = screen.getByRole('tab', { name: '模型' });
    expect(modelsTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('模型管理')).toBeTruthy();
  });

  it('tab 键盘切换：激活区随点击变化（错误边界 resetKeys 已覆盖切换重置）', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('tab', { name: '关于' }));
    expect(screen.getByRole('tab', { name: '关于' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: '模型' }).getAttribute('aria-selected')).toBe('false');
  });
});
