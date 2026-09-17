// src/renderer/components/settings/sections/__tests__/remote-control-section.test.tsx
// RemoteControlSection 单测：启停开关 / 配对凭据与二维码 / 复制令牌 / 审批模式警告
// ──────────────────────────────────────────────────────────────
// 数据源 mock：window.api.remote.*（getStatus/start/stop）+ settings.getApprovalMode
// 全部 stub；qrcode 只 stub 到 data URL 生成边界（本用例锁"编码了什么"，
// 二维码点阵正确性由 qrcode 自身保证）。开关交互、凭据渲染规则走真实实现。
// ──────────────────────────────────────────────────────────────

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteControlSection } from './remote-control-section';

// 二维码 stub：只 mock 到 data URL 生成边界，编码内容/参数由下方断言锁定
const qrMock = vi.hoisted(() => ({
  encode: vi.fn(async (): Promise<string> => 'data:image/png;base64,QR'),
}));
// biome-ignore lint/style/useNamingConvention: 必须保留 qrcode 的真实导出名
vi.mock('qrcode', () => ({ toDataURL: qrMock.encode }));

const IDLE = {
  running: false,
  port: null,
  token: null,
  instanceName: 'dev-desktop',
  addresses: [],
  activeCommands: 0,
  lastCommandAt: null,
};

const ONLINE = {
  running: true,
  port: 45918,
  token: 'tok-abc123',
  instanceName: 'dev-desktop',
  addresses: ['http://192.168.1.10:45918'],
  activeCommands: 1,
  lastCommandAt: Date.now(),
};

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(async () => ({ data: {} as unknown })),
  start: vi.fn(async () => ({ data: {} as unknown })),
  stop: vi.fn(async () => ({ data: {} as unknown })),
  getApprovalMode: vi.fn(async () => ({ data: { mode: 'auto' } })),
  writeText: vi.fn(async () => {}),
}));

function renderSection(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RemoteControlSection />
    </QueryClientProvider>,
  );
}

/** 设置 getStatus 返回快照 */
function stubStatus(status: unknown): void {
  mocks.getStatus.mockResolvedValue({ data: status } as never);
}

describe('RemoteControlSection 远程控制面板', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubStatus(IDLE);
    mocks.start.mockResolvedValue({ data: ONLINE } as never);
    mocks.stop.mockResolvedValue({ data: IDLE } as never);
    mocks.getApprovalMode.mockResolvedValue({ data: { mode: 'auto' } } as never);
    window.api = {
      remote: {
        getStatus: mocks.getStatus,
        start: mocks.start,
        stop: mocks.stop,
      },
      settings: { getApprovalMode: mocks.getApprovalMode },
    } as never;
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mocks.writeText },
    });
  });

  afterEach(() => {
    window.api = undefined as never;
  });

  it('未运行：开关处于关闭态且不展示配对凭据', async () => {
    renderSection();
    const toggle = await screen.findByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByText('tok-abc123')).toBeNull();
  });

  it('运行中：展示令牌、端口与局域网端点', async () => {
    stubStatus(ONLINE);
    renderSection();
    expect(await screen.findByText('tok-abc123')).toBeTruthy();
    expect(screen.getByText('http://192.168.1.10:45918')).toBeTruthy();
    expect(screen.getByText('dev-desktop · 端口 45918')).toBeTruthy();
    expect(screen.getByText('执行中 1 条')).toBeTruthy();
    expect((await screen.findByRole('switch')).getAttribute('aria-checked')).toBe('true');
  });

  it('开启开关：调用 remote:start 并立即回显返回快照（不等轮询）', async () => {
    renderSection();
    const toggle = await screen.findByRole('switch');
    await userEvent.click(toggle);
    await waitFor(() => {
      expect(mocks.start).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText('tok-abc123')).toBeTruthy();
  });

  it('关闭开关：调用 remote:stop 并收起凭据卡', async () => {
    stubStatus(ONLINE);
    renderSection();
    const toggle = await screen.findByRole('switch');
    await userEvent.click(toggle);
    await waitFor(() => {
      expect(mocks.stop).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByText('tok-abc123')).toBeNull();
    });
  });

  it('复制令牌：写入系统剪贴板', async () => {
    stubStatus(ONLINE);
    renderSection();
    const copyBtn = await screen.findByRole('button', { name: '复制令牌' });
    await userEvent.click(copyBtn);
    await waitFor(() => {
      expect(mocks.writeText).toHaveBeenCalledWith('tok-abc123');
    });
  });

  it('审批模式非 auto/yolo：显示无头执行会被拒绝的警告', async () => {
    stubStatus(ONLINE);
    mocks.getApprovalMode.mockResolvedValue({ data: { mode: 'ask' } } as never);
    renderSection();
    expect(await screen.findByText(/远程指令会被拒绝执行/)).toBeTruthy();
  });

  it('auto 模式：不显示审批模式警告', async () => {
    stubStatus(ONLINE);
    renderSection();
    await screen.findByText('tok-abc123');
    expect(screen.queryByText(/远程指令会被拒绝执行/)).toBeNull();
  });

  it('运行中但无局域网地址：显示地址缺失降级提示', async () => {
    stubStatus({ ...ONLINE, addresses: [] });
    renderSection();
    expect(await screen.findByText(/未检测到局域网 IPv4 地址/)).toBeTruthy();
  });

  it('配对二维码：编码「端点#令牌」（fragment 不落服务端日志）', async () => {
    stubStatus(ONLINE);
    renderSection();
    expect(await screen.findByAltText('远程控制配对二维码')).toBeTruthy();
    expect(qrMock.encode).toHaveBeenCalledWith(
      'http://192.168.1.10:45918#tok-abc123',
      expect.objectContaining({ errorCorrectionLevel: 'M' }),
    );
  });

  it('无局域网端点：不生成二维码（无地址可编码）', async () => {
    stubStatus({ ...ONLINE, addresses: [] });
    renderSection();
    await screen.findByText('tok-abc123');
    expect(qrMock.encode).not.toHaveBeenCalled();
    expect(screen.queryByAltText('远程控制配对二维码')).toBeNull();
  });

  it('二维码生成失败：静默降级，令牌文本仍可用于手动配对', async () => {
    stubStatus(ONLINE);
    qrMock.encode.mockRejectedValueOnce(new Error('canvas unavailable'));
    renderSection();
    expect(await screen.findByText('tok-abc123')).toBeTruthy();
    await waitFor(() => expect(qrMock.encode).toHaveBeenCalled());
    expect(screen.queryByAltText('远程控制配对二维码')).toBeNull();
  });
});
