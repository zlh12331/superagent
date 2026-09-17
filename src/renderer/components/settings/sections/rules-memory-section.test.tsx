// src/renderer/components/settings/sections/rules-memory-section.test.tsx
// RulesMemorySection 测试：规则说明与记忆面板挂载点渲染
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { RulesMemorySection } from './rules-memory-section';

const t = i18n.t.bind(i18n);

/** 区块内含记忆面板（TanStack Query 消费者），无 provider 会直接抛错 */
function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RulesMemorySection', () => {
  it('正向：渲染规则说明与记忆面板挂载点', () => {
    window.api = {
      memory: {
        list: vi.fn().mockResolvedValue({ data: { memories: [] } }),
        status: vi.fn().mockResolvedValue({ data: null }),
      },
    } as never;
    renderWithQuery(<RulesMemorySection />);

    expect(screen.getByText(t('settings.rulesTitle'))).toBeDefined();
    expect(screen.getByText(t('settings.memoryTitle'))).toBeDefined();
  });
});
