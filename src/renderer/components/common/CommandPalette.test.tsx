import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '@/providers/ThemeProvider';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { CommandPalette } from './CommandPalette';

describe('CommandPalette 冒烟', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ theme: 'dark' });
    window.api.session = {
      list: vi.fn(async () => ({ data: { sessions: [], total: 0 } })),
    } as never;
    window.api.file = { list: vi.fn(async () => ({ data: { entries: [] } })) } as never;
  });

  function renderPalette() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ThemeProvider>
            <CommandPalette open onOpenChange={vi.fn()} />
          </ThemeProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('操作组命令渲染：新建会话 / 切换主题 / 打开设置', () => {
    renderPalette();
    expect(screen.getByText('新建会话')).toBeDefined();
    expect(screen.getByText('打开设置')).toBeDefined();
    expect(screen.getByText('切换到亮色主题')).toBeDefined();
  });

  it('主题命令标题随三态循环：system → 切换到暗色主题', () => {
    useSettingsStore.setState({ theme: 'system' });
    renderPalette();
    expect(screen.getByText('切换到暗色主题')).toBeDefined();
  });

  it('主题命令标题随三态循环：light → 切换到跟随系统主题', () => {
    useSettingsStore.setState({ theme: 'light' });
    renderPalette();
    expect(screen.getByText('切换到跟随系统主题')).toBeDefined();
  });
});
