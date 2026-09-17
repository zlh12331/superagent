// src/renderer/components/settings/sections/telemetry-section.test.tsx
// TelemetrySection 测试：三档遥测渲染 + 浏览器模式降级
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { TelemetrySection } from './telemetry-section';

const t = i18n.t.bind(i18n);

/** 区块内含 TanStack Query 消费者，无 provider 会直接抛「No QueryClient set」 */
function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TelemetrySection', () => {
  it('正向：渲染三档遥测选项', async () => {
    window.api = {
      settings: {
        getTelemetryLevel: vi.fn().mockResolvedValue({ data: { level: 'full' } }),
        setTelemetryLevel: vi.fn(),
      },
    } as never;
    renderWithQuery(<TelemetrySection />);

    expect(screen.getByText(t('settings.telOff'))).toBeDefined();
    expect(screen.getByText(t('settings.telErrorOnly'))).toBeDefined();
    expect(screen.getByText(t('settings.telFull'))).toBeDefined();
  });

  it('边界：浏览器模式（无桥）→ 渲染三档且不抛错', () => {
    (window as unknown as { api: undefined }).api = undefined;
    renderWithQuery(<TelemetrySection />);

    // 无桥时查询回落 off，UI 仍完整渲染
    expect(screen.getByText(t('settings.telOff'))).toBeDefined();
  });
});
