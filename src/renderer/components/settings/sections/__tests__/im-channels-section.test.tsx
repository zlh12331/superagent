// src/renderer/components/settings/sections/__tests__/im-channels-section.test.tsx
// IM 渠道区块测试（正向 / 边界 / 异常）
// ──────────────────────────────────────────────────────────────
// 覆盖动机：该文件此前 0% 覆盖（本轮覆盖率排查确认）。它是 7 渠道（QQ/微信/钉钉/
// Telegram/飞书/企微/webhook）的统一启停界面，含查询 + 启停 mutation + token 输入，
// 且启停按钮的禁用条件有三个维度（busy / running / implemented）。
//
// 重点关注：
// 1. 查询失败 → 错误态可重试（历史上曾静默降级为空列表）
// 2. 启停按钮分派：running → 停止，否则 → 启动
// 3. 禁用矩阵：busy / 未实现渠道不可启动
// 4. token 输入仅在「已实现且未配置」时出现，启动时随 token 一并提交
// ──────────────────────────────────────────────────────────────

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

const { mockToastError, mockToastSuccess } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: { success: mockToastSuccess, error: mockToastError, warning: vi.fn() },
}));

import { ImChannelsSection } from '../im-channels-section';

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ImChannelsSection />
    </QueryClientProvider>,
  );
}

/** 构造渠道条目 */
function channel(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'telegram',
    displayName: 'Telegram',
    description: '默认渠道',
    implemented: true,
    configured: true,
    running: false,
    ...overrides,
  };
}

/**
 * 装配 window.api.im
 *
 * start/stop 传入时**原样使用**（调用方已在其中设置 resolve/reject 行为）——
 * 不要在此再 mockResolvedValue：那会覆盖调用方设定的失败行为。
 */
function setupApi(
  list: () => Promise<unknown>,
  start?: ReturnType<typeof vi.fn>,
  stop?: ReturnType<typeof vi.fn>,
) {
  const api = {
    list: vi.fn(list),
    start: start ?? vi.fn().mockResolvedValue({ data: { ok: true } }),
    stop: stop ?? vi.fn().mockResolvedValue({ data: { ok: true } }),
  };
  window.api = {
    im: api,
    settings: { getAll: vi.fn().mockResolvedValue({ data: { settings: {} } }) },
  } as never;
  return api;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ImChannelsSection · 查询与展示', () => {
  it('正向：渲染已实现渠道 + 未运行状态 + 启动按钮', async () => {
    setupApi(async () => ({ data: { channels: [channel()] } }));
    renderSection();

    await waitFor(() => expect(screen.getByText('Telegram')).toBeDefined());
    expect(screen.getByText(i18n.t('settings.imChannelStopped'))).toBeDefined();
    expect(screen.getByRole('button', { name: i18n.t('settings.imChannelStart') })).toBeEnabled();
  });

  it('正向：运行中渠道显示运行态 + 停止按钮', async () => {
    setupApi(async () => ({ data: { channels: [channel({ running: true })] } }));
    renderSection();

    await waitFor(() =>
      expect(screen.getByText(i18n.t('settings.imChannelRunning'))).toBeDefined(),
    );
    expect(screen.getByRole('button', { name: i18n.t('settings.imChannelStop') })).toBeDefined();
  });

  it('边界：未实现渠道不可启动（按钮禁用）', async () => {
    setupApi(async () => ({ data: { channels: [channel({ implemented: false })] } }));
    renderSection();

    await waitFor(() => expect(screen.getByText('Telegram')).toBeDefined());
    expect(screen.getByRole('button', { name: i18n.t('settings.imChannelStart') })).toBeDisabled();
  });

  it('边界：空渠道列表 → 不渲染任何行（且不崩溃）', async () => {
    setupApi(async () => ({ data: { channels: [] } }));
    renderSection();

    await waitFor(() =>
      expect(screen.getByText(i18n.t('settings.imChannelsSection'))).toBeDefined(),
    );
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('异常：列表失败 → 错误态 + 重试入口（不静默降级为空列表）', async () => {
    setupApi(async () => ({ error: { code: 'IM_LIST_FAILED', message: 'ipc down' } }));
    renderSection();

    await waitFor(() => expect(screen.getByText(/ipc down/)).toBeDefined());
    expect(screen.getByRole('button', { name: new RegExp(i18n.t('common.retry')) })).toBeDefined();
  });
});

describe('ImChannelsSection · 启停', () => {
  it('正向：点启动 → im.start（未填 token 时 token 为 undefined）', async () => {
    const api = setupApi(async () => ({ data: { channels: [channel()] } }));
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: i18n.t('settings.imChannelStart') }));

    await waitFor(() => expect(api.start).toHaveBeenCalled());
    expect(api.start).toHaveBeenCalledWith({ kind: 'telegram', token: undefined });
  });

  it('正向：点停止 → im.stop', async () => {
    const api = setupApi(async () => ({ data: { channels: [channel({ running: true })] } }));
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: i18n.t('settings.imChannelStop') }));

    await waitFor(() => expect(api.stop).toHaveBeenCalledWith({ kind: 'telegram' }));
  });

  it('异常：启动失败（错误信封）→ 失败提示', async () => {
    const start = vi.fn().mockResolvedValue({ error: { code: 'IM_START_FAILED', message: 'no' } });
    setupApi(async () => ({ data: { channels: [channel()] } }), start);
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: i18n.t('settings.imChannelStart') }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(i18n.t('settings.imChannelStartFailed')),
    );
  });

  it('异常：停止抛错 → 失败提示且不冒泡未处理 rejection', async () => {
    const stop = vi.fn().mockRejectedValue(new Error('boom'));
    setupApi(async () => ({ data: { channels: [channel({ running: true })] } }), vi.fn(), stop);
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: i18n.t('settings.imChannelStop') }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(i18n.t('settings.imChannelStopFailed')),
    );
  });
});

describe('ImChannelsSection · token 首次配置', () => {
  it('边界：已实现但未配置 → 显示 token 输入框', async () => {
    setupApi(async () => ({ data: { channels: [channel({ configured: false })] } }));
    renderSection();

    await waitFor(() =>
      expect(
        screen.getByPlaceholderText(i18n.t('settings.imChannelTokenPlaceholder')),
      ).toBeDefined(),
    );
  });

  it('边界：已配置渠道不显示 token 输入框', async () => {
    setupApi(async () => ({ data: { channels: [channel({ configured: true })] } }));
    renderSection();

    await waitFor(() => expect(screen.getByText('Telegram')).toBeDefined());
    expect(screen.queryByPlaceholderText(i18n.t('settings.imChannelTokenPlaceholder'))).toBeNull();
  });

  it('正向：填写 token 后启动 → token 随 im.start 提交', async () => {
    const api = setupApi(async () => ({ data: { channels: [channel({ configured: false })] } }));
    renderSection();

    const input = await screen.findByPlaceholderText(i18n.t('settings.imChannelTokenPlaceholder'));
    fireEvent.change(input, { target: { value: '  tok-123  ' } });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('settings.imChannelStart') }));

    await waitFor(() => expect(api.start).toHaveBeenCalled());
    // 首尾空格被 trim
    expect(api.start).toHaveBeenCalledWith({ kind: 'telegram', token: 'tok-123' });
  });
});

describe('ImChannelsSection · 浏览器模式（无桥）', () => {
  it('无 window.api：列表为空且不抛错', async () => {
    (window as unknown as { api: undefined }).api = undefined;
    renderSection();

    await waitFor(() =>
      expect(screen.getByText(i18n.t('settings.imChannelsSection'))).toBeDefined(),
    );
    expect(screen.queryByRole('listitem')).toBeNull();
  });
});
