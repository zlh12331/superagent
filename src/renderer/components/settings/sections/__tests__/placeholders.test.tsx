// src/renderer/components/settings/sections/__tests__/placeholders.test.tsx
// 移动端 pane 组合测试（正向 / 边界 / 异常）
// ──────────────────────────────────────────────────────────────
// 覆盖动机：该文件是本轮覆盖率排查中最后一个 0% 文件（general-section 会渲染它，
// 但没有断言其内容，故此前完全未被统计到）。
// 职责：把「局域网远程控制配对 + IM 渠道配置」两块真实能力组合为一个 pane。
//
// 数据源 mock：window.api.remote.*（getStatus，子面板走 useRemoteStatusQuery）
// + window.api.im.list。两块子面板自身行为各有专属单测（remote-control-section /
// im-channels-section），本文件只锁「组合层」：两者都能挂载、独立取数、互不拖垮。
// ──────────────────────────────────────────────────────────────

import type { RemoteStatusRes } from '@code-agent/shared/renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
// 二维码：组合层不校验点阵，仅需可解析的 data URL
vi.mock('qrcode', () => ({
  // biome-ignore lint/style/useNamingConvention: 必须保留 qrcode 的真实导出名
  toDataURL: vi.fn(async (): Promise<string> => 'data:image/png;base64,QR'),
}));

import { MobileSection } from '../placeholders';

const t = i18n.t.bind(i18n);

/** 未运行状态（面板渲染「已停止」分支，不触发配对卡片等重活） */
const IDLE: RemoteStatusRes = {
  running: false,
  port: null,
  token: null,
  instanceName: 'test-host',
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

    // 两块子面板各自的标题（组合层不再自造标题，避免与子面板标题重复）
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

    // 组合层无自建错误边界，但不应崩溃：IM 侧照常渲染
    await waitFor(() => expect(screen.getByText(t('settings.imChannelsSection'))).toBeDefined());
  });
});
