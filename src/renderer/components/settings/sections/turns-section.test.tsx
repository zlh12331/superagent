import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { TurnsSection } from './turns-section';

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TurnsSection />
    </QueryClientProvider>,
    {
      wrapper: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
    },
  );
}

/** 装配 window.api.session.getRecentTurns */
function setupApi(getRecentTurns: () => Promise<unknown>) {
  window.api = { session: { getRecentTurns } } as never;
}

/** 构造一个 turn */
function turn(overrides: Record<string, unknown> = {}) {
  return {
    turnId: 't1',
    seq: 1,
    modelId: 'deepseek-chat',
    status: 'completed',
    totalTokens: 1200,
    durationMs: 3400,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TurnsSection', () => {
  it('正向：渲染回合列表，含模型名、序号、状态与元信息', async () => {
    setupApi(async () => ({ data: { turns: [turn()] } }));
    renderSection();

    await waitFor(() => expect(screen.getByText('deepseek-chat')).toBeDefined());
    expect(screen.getByText('#1')).toBeDefined();
    const row = screen.getByText('deepseek-chat').closest('li')?.textContent ?? '';
    expect(row).toContain(i18n.t('settings.turnStatusCompleted'));
    expect(row).toContain(i18n.t('chat.turnMetaTokens', { count: 1200 }));
    expect(row).toContain(i18n.t('chat.turnMetaDuration', { seconds: 3 }));
  });

  it('查询契约：按 limit 10 拉取', async () => {
    const getRecentTurns = vi.fn().mockResolvedValue({ data: { turns: [] } });
    setupApi(getRecentTurns);
    renderSection();

    await waitFor(() => expect(getRecentTurns).toHaveBeenCalled());
    expect(getRecentTurns).toHaveBeenCalledWith({ limit: 10 });
  });

  it('边界：空列表 → 空态文案（非错误态）', async () => {
    setupApi(async () => ({ data: { turns: [] } }));
    renderSection();

    await waitFor(() => expect(screen.getByText(i18n.t('settings.turnsEmpty'))).toBeDefined());
  });

  it('边界：可选元信息缺失时不渲染对应片段（不显示 undefined）', async () => {
    setupApi(async () => ({
      data: { turns: [turn({ totalTokens: undefined, durationMs: undefined })] },
    }));
    renderSection();

    await waitFor(() => expect(screen.getByText('deepseek-chat')).toBeDefined());
    const row = screen.getByText('deepseek-chat').closest('li');
    expect(row?.textContent).not.toContain('undefined');
    expect(row?.textContent).not.toContain('NaN');
  });

  it('边界：状态文案映射覆盖四种终止原因', async () => {
    setupApi(async () => ({
      data: {
        turns: [
          turn({ turnId: 'a', seq: 1, status: 'completed' }),
          turn({ turnId: 'b', seq: 2, status: 'aborted' }),
          turn({ turnId: 'c', seq: 3, status: 'max-steps' }),
          turn({ turnId: 'd', seq: 4, status: 'error' }),
        ],
      },
    }));
    renderSection();

    await waitFor(() => expect(screen.getByText('#1')).toBeDefined());
    const all = document.body.textContent ?? '';
    expect(all).toContain(i18n.t('settings.turnStatusCompleted'));
    expect(all).toContain(i18n.t('settings.turnStatusAborted'));
    expect(all).toContain(i18n.t('settings.turnStatusMaxSteps'));
    expect(all).toContain(i18n.t('settings.turnStatusError'));
  });

  it('异常：未知状态回落为原始状态串（不崩溃、不显示空）', async () => {
    setupApi(async () => ({ data: { turns: [turn({ status: 'weird-status' })] } }));
    renderSection();

    await waitFor(() => expect(screen.getByText(/weird-status/)).toBeDefined());
  });

  it('异常：错误信封 → 错误态 + 可重试（不静默渲染成空态）', async () => {
    setupApi(async () => ({ error: { code: 'TURNS_FAILED', message: 'boom' } }));
    renderSection();

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    const all = document.body.textContent ?? '';
    expect(all).toContain('errors.TURNS_FAILED');
    expect(all).not.toContain('boom');
    expect(screen.getByRole('button', { name: new RegExp(i18n.t('common.retry')) })).toBeDefined();
  });

  it('异常：请求抛错同样进入错误态', async () => {
    setupApi(() => Promise.reject(new Error('ipc down')));
    renderSection();

    await waitFor(() => expect(screen.getByText(/ipc down/)).toBeDefined());
  });
});
