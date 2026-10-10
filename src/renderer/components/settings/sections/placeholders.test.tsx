import type { RemoteStatusRes } from '@code-agent/shared/renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('qrcode', () => ({
  // biome-ignore lint/style/useNamingConvention: 必须保留 qrcode 的真实导出名
  toDataURL: vi.fn(async (): Promise<string> => 'data:image/png;base64,QR'),
}));

import { MobileSection } from './placeholders';

const t = i18n.t.bind(i18n);

/** 未运行状态（面板渲染「已停止」分支，不触发配对卡片等重活） */
const IDLE: RemoteStatusRes = {
  running: false,
  port: null,
  token: null,
  instanceName: 'test-host',
  bindScope: 'lan',
  addresses: [],
  activeCommands: 0,
  lastCommandAt: null,
};

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(async () => ({ data: {} as unknown })),
  imList: vi.fn(async () => ({ data: {} as unknown })),
  getApprovalMode: vi.fn(async () => ({ data: { mode: 'auto' } })),
}));

function mockApi(
  status: unknown = { data: IDLE },
  imList: unknown = { data: { channels: [] } },
): void {
  mocks.getStatus.mockResolvedValue(status as never);
  mocks.imList.mockResolvedValue(imList as never);
  window.api = {
    remote: { getStatus: mocks.getStatus, start: vi.fn(), stop: vi.fn() },
    im: { list: mocks.imList },
    settings: { getApprovalMode: mocks.getApprovalMode },
  } as never;
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MobileSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi();
});

describe('MobileSection', () => {
  it('正向：组合渲染远程控制与 IM 渠道两块内容', async () => {
    renderSection();

    await waitFor(() => expect(screen.getByText(t('settings.remote.section'))).toBeDefined());
    expect(screen.getByText(t('settings.imChannelsSection'))).toBeDefined();
  });

  it('组合层：两块子面板各自独立取数（互不阻塞）', async () => {
    renderSection();

    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalled());
    expect(mocks.imList).toHaveBeenCalled();
  });

  it('边界：两块子面板共享同一 QueryClient 且能同时挂载', async () => {
    renderSection();

    await waitFor(() => expect(screen.getByText(t('settings.remote.section'))).toBeDefined());
    expect(screen.getByText(t('settings.imChannelsSection'))).toBeDefined();
  });

  it('异常：远程控制取数失败不拖垮整组合（IM 侧仍渲染）', async () => {
    mockApi({ error: { code: 'INTERNAL_ERROR', message: 'rc down' } });
    renderSection();

    await waitFor(() => expect(screen.getByText(t('settings.imChannelsSection'))).toBeDefined());
  });
});
