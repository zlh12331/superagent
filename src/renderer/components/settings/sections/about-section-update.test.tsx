// src/renderer/components/settings/sections/about-section-update.test.tsx
// 关于面板「更新区」测试：进度 / 取消 / 跳过 / 说明折叠 / 错误分类 / 开关
// ──────────────────────────────────────────────
// 覆盖动机：关于面板是更新功能最复杂的界面（进度条、取消、跳过、说明、错误文案、
// 开关），此前 0 测试。这里用真实 settings-store + 可控的 useUpdate mock，
// 断言各 phase 下的真实渲染与交互，避免后续改动静默回归。
// ──────────────────────────────────────────────

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/persistent/settings-store';

const mockUpdate = vi.hoisted(() => ({
  value: {
    state: null as null | Record<string, unknown>,
    fromSnapshot: false,
    lastCheckAt: null as number | null,
    check: vi.fn(async () => {}),
    cancel: vi.fn(),
    install: vi.fn(),
  },
}));
const installUpdateSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('@/hooks/use-update', () => ({
  useUpdate: (): typeof mockUpdate.value => mockUpdate.value,
}));
vi.mock('@/hooks/use-install-update', () => ({
  useInstallUpdate: (): typeof installUpdateSpy => installUpdateSpy,
}));
vi.mock('@/hooks/use-app-info', () => ({
  useAppInfo: () => ({ version: '1.0.0', platform: 'win32', arch: 'x64', channel: 'stable' }),
}));

import { AboutSection } from './about-section';

const t = i18n.t.bind(i18n);

/** 设置更新状态并渲染关于面板 */
function renderWith(
  state: Record<string, unknown> | null,
  overrides: Partial<typeof mockUpdate.value> = {},
): ReturnType<typeof render> {
  mockUpdate.value = {
    state,
    fromSnapshot: false,
    lastCheckAt: null,
    check: vi.fn(async () => {}),
    cancel: vi.fn(),
    install: vi.fn(),
    ...overrides,
  };
  return render(<AboutSection />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ update: { autoCheck: true, skippedVersion: null } });
});

describe('关于面板 · 更新区', () => {
  it('未检查：渲染「检查更新」，点击触发 check', async () => {
    renderWith(null);
    const button = screen.getByRole('button', { name: t('settings.aboutCheckUpdate') });
    await userEvent.click(button);
    expect(mockUpdate.value.check).toHaveBeenCalledOnce();
  });

  it('下载中：渲染进度条（含 percent 语义）、取消按钮与字节详情', () => {
    renderWith({
      phase: 'downloading',
      version: '1.2.0',
      progress: 42,
      transferred: 12_000_000,
      total: 48_000_000,
      bytesPerSecond: 2_100_000,
    });
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    // 详情行：字节 / 总量 · 速率 · 剩余（percent 只在 aria 上，视觉上面板给的是绝对值）
    expect(screen.getByText(/11\.4 MB \/ 45\.8 MB/)).toBeTruthy();
    expect(screen.getByText(/2\.0 MB\/s/)).toBeTruthy();
    expect(screen.getByRole('button', { name: t('update.cancel') })).toBeTruthy();
  });

  it('下载中：点击取消触发 cancel', async () => {
    renderWith({ phase: 'downloading', version: '1.2.0', progress: 10 });
    await userEvent.click(screen.getByRole('button', { name: t('update.cancel') }));
    expect(mockUpdate.value.cancel).toHaveBeenCalledOnce();
  });

  it('就绪：渲染重启并安装（经 use-install-update，而非直接 install）与跳过按钮', async () => {
    renderWith({ phase: 'downloaded', version: '1.2.0' });
    await userEvent.click(screen.getByRole('button', { name: t('settings.aboutInstallRestart') }));
    expect(installUpdateSpy).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: t('update.skipVersion') })).toBeTruthy();
  });

  it('就绪：有更新说明时渲染折叠区，展开可看全文', async () => {
    const notes = ['第一行', '第二行', '第三行', '第四行'].join('\n');
    renderWith({ phase: 'downloaded', version: '1.2.0', releaseNotes: notes });
    expect(screen.getByText(t('update.notesTitle'))).toBeTruthy();
    const expand = screen.getByRole('button', { name: t('update.notesExpand') });
    await userEvent.click(expand);
    expect(screen.getByText(/第四行/)).toBeTruthy();
  });

  it('错误分类：network → 本地化文案（不展示原始英文）', () => {
    renderWith({ phase: 'error', errorKind: 'network', message: 'net::ERR_FAILED' });
    expect(screen.getByText(t('update.errNetwork'))).toBeTruthy();
    expect(screen.queryByText(/net::ERR_FAILED/)).toBeNull();
  });

  it('错误分类：unknown → 保留原始 message（排查线索不丢）', () => {
    renderWith({
      phase: 'error',
      errorKind: 'unknown',
      message: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
    });
    expect(screen.getByText(/ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/)).toBeTruthy();
  });

  it('已取消：就地提示并提供再次检查入口', () => {
    renderWith({ phase: 'cancelled', version: '1.2.0' });
    expect(screen.getByText(t('settings.aboutCancelled'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('settings.aboutCheckUpdate') })).toBeTruthy();
  });

  it('跳过态：展示已跳过并提供取消跳过（写回 settings）', async () => {
    useSettingsStore.setState({ update: { autoCheck: true, skippedVersion: '1.2.0' } });
    renderWith({ phase: 'downloaded', version: '1.2.0' });
    expect(screen.getByText(t('settings.aboutSkipped', { version: '1.2.0' }))).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: t('settings.aboutUnskip') }));
    expect(useSettingsStore.getState().update.skippedVersion).toBeNull();
  });

  it('跳过的是别的版本：不展示跳过态（版本号不等即失效）', () => {
    useSettingsStore.setState({ update: { autoCheck: true, skippedVersion: '1.0.0' } });
    renderWith({ phase: 'downloaded', version: '1.2.0' });
    expect(screen.queryByText(t('settings.aboutSkipped', { version: '1.0.0' }))).toBeNull();
  });

  it('上次检查时间：有值才展示', () => {
    renderWith({ phase: 'not-available' }, { lastCheckAt: Date.UTC(2026, 0, 2, 3, 4) });
    expect(
      screen.getByText(new RegExp(t('settings.aboutLastCheck', { time: '' }).slice(0, 4))),
    ).toBeTruthy();
  });

  it('开关：关闭时写入 settings 且不触发检查；打开时写入并立即补检', async () => {
    const check = vi.fn(async () => {});
    renderWith(null, { check });
    const toggle = screen.getByRole('switch', { name: t('settings.aboutAutoCheck') });

    await userEvent.click(toggle);
    await waitFor(() => expect(useSettingsStore.getState().update.autoCheck).toBe(false));
    expect(check).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('switch', { name: t('settings.aboutAutoCheck') }));
    await waitFor(() => expect(useSettingsStore.getState().update.autoCheck).toBe(true));
    expect(check).toHaveBeenCalledOnce();
  });
});
