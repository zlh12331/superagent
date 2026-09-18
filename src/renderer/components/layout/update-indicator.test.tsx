// src/renderer/components/layout/update-indicator.test.tsx
// 顶栏更新指示测试：可见三态（隐藏 / 下载中 / 就绪）+ 点击行为 + 静默（跳过与稍后）
// ──────────────────────────────────────────────
// 覆盖动机：指示器此前 0 测试，而它承载"静默可见性"这一关键取舍——
// 只在下中/就绪出现、下载中直达关于面板、就绪开操作菜单、跳过与稍后都不打扰。
// 状态直接写 update-store（指示器读 store，不再自行订阅）。
// ──────────────────────────────────────────────

import type { UpdateStatusPayload } from '@code-agent/shared/renderer';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { useUiStore } from '@/stores/transient/ui-store';
import { useUpdateStore } from '@/stores/transient/update-store';

const installSpy = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/hooks/use-install-update', () => ({ useInstallUpdate: () => installSpy }));

import { UpdateIndicator } from './update-indicator';

const t = i18n.t.bind(i18n);

/** 写入更新状态并渲染指示器 */
function renderWith(status: UpdateStatusPayload | null): ReturnType<typeof render> {
  useUpdateStore.setState({ status, fromSnapshot: false, lastCheckAt: null });
  return render(<UpdateIndicator />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useUpdateStore.setState({ status: null, fromSnapshot: false, lastCheckAt: null });
  useSettingsStore.setState({ update: { autoCheck: true, skippedVersion: null } });
  useUiStore.setState({ settingsOpen: false, settingsSection: null });
});

describe('顶栏更新指示', () => {
  it('空闲 / 检查中 / 已最新：不渲染指示（启动时不闪图标）', () => {
    const silentStates: readonly (UpdateStatusPayload | null)[] = [
      null,
      { phase: 'checking' },
      { phase: 'not-available' },
    ];
    for (const status of silentStates) {
      const { container, unmount } = renderWith(status);
      expect(container.firstChild).toBeNull();
      unmount();
    }
  });

  it('下载中：渲染按钮（aria 含百分比），点击打开设置并直达关于面板', async () => {
    renderWith({ phase: 'downloading', version: '1.2.0', progress: 42 });
    const button = screen.getByRole('button', {
      name: t('update.indicatorDownloading', { percent: '42' }),
    });
    await userEvent.click(button);
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().settingsSection).toBe('about');
  });

  it('就绪：渲染徽标按钮，打开菜单可见重启并安装 / 稍后 / 跳过此版本', async () => {
    renderWith({ phase: 'downloaded', version: '1.2.0' });
    await userEvent.click(
      screen.getByRole('button', { name: t('update.indicatorReady', { version: '1.2.0' }) }),
    );
    expect(await screen.findByText(t('update.restartNow'))).toBeTruthy();
    expect(screen.getByText(t('update.later'))).toBeTruthy();
    expect(screen.getByText(t('update.skipVersion'))).toBeTruthy();
  });

  it('就绪：菜单「稍后」→ 本会话隐藏该版本指示', async () => {
    renderWith({ phase: 'downloaded', version: '1.2.0' });
    await userEvent.click(
      screen.getByRole('button', { name: t('update.indicatorReady', { version: '1.2.0' }) }),
    );
    await userEvent.click(await screen.findByText(t('update.later')));
    expect(
      screen.queryByRole('button', { name: t('update.indicatorReady', { version: '1.2.0' }) }),
    ).toBeNull();
    // 仅本会话隐藏：settings 未被写入
    expect(useSettingsStore.getState().update.skippedVersion).toBeNull();
  });

  it('就绪：菜单「跳过此版本」→ 写入 settings 且指示消失', async () => {
    renderWith({ phase: 'downloaded', version: '1.2.0' });
    await userEvent.click(
      screen.getByRole('button', { name: t('update.indicatorReady', { version: '1.2.0' }) }),
    );
    await userEvent.click(await screen.findByText(t('update.skipVersion')));
    expect(useSettingsStore.getState().update.skippedVersion).toBe('1.2.0');
    expect(
      screen.queryByRole('button', { name: t('update.indicatorReady', { version: '1.2.0' }) }),
    ).toBeNull();
  });

  it('已跳过该版本（持久）：不渲染指示（跨会话静默）', () => {
    useSettingsStore.setState({ update: { autoCheck: true, skippedVersion: '1.2.0' } });
    const { container } = renderWith({ phase: 'downloaded', version: '1.2.0' });
    expect(container.firstChild).toBeNull();
  });

  it('跳过的是别的版本：仍渲染指示', () => {
    useSettingsStore.setState({ update: { autoCheck: true, skippedVersion: '1.0.0' } });
    renderWith({ phase: 'downloaded', version: '1.2.0' });
    expect(
      screen.getByRole('button', { name: t('update.indicatorReady', { version: '1.2.0' }) }),
    ).toBeTruthy();
  });

  it('就绪：菜单「重启并安装」走 use-install-update（含运行中回合确认）', async () => {
    renderWith({ phase: 'downloaded', version: '1.2.0' });
    await userEvent.click(
      screen.getByRole('button', { name: t('update.indicatorReady', { version: '1.2.0' }) }),
    );
    await userEvent.click(await screen.findByText(t('update.restartNow')));
    expect(installSpy).toHaveBeenCalledOnce();
  });
});
