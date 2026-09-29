// src/renderer/components/settings/sections/notification-section.test.tsx
// NotificationSection 测试：断言 store 实质状态（33 号 spec V9 + 写穿透）
// ──────────────────────────────────────────────────────────────
// 覆盖：
// - 三开关渲染与默认态（全开）
// - 总开关关 → 两个事件开关 disabled（V9），描述切换为引导文案
// - toggle 事件开关 → updateNotification 经 store 部分合并 + 写穿透（setSpy 捕获）
// ──────────────────────────────────────────────────────────────

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/persistent/settings-store';

import { NotificationSection } from './notification-section';

const t = i18n.t.bind(i18n);

const setSpy = vi.fn(async () => ({ data: { ok: true } }));

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'api', {
    value: { settings: { set: setSpy } },
    writable: true,
    configurable: true,
  });
  useSettingsStore.setState({
    notification: { enabled: true, onTurnFinished: true, onTurnFailed: true },
  });
});

describe('NotificationSection', () => {
  it('默认态：三个开关渲染且全开', () => {
    render(<NotificationSection />);

    for (const key of [
      'settings.notificationLabel',
      'settings.notificationFinishedLabel',
      'settings.notificationFailedLabel',
    ]) {
      const toggle = screen.getByRole('switch', { name: t(key) });
      expect(toggle).toBeDefined();
      expect(toggle).not.toBeDisabled();
    }
  });

  it('V9：总开关关 → 事件开关禁用且描述切换为引导文案', async () => {
    render(<NotificationSection />);

    await userEvent.click(screen.getByRole('switch', { name: t('settings.notificationLabel') }));

    const finished = screen.getByRole('switch', {
      name: t('settings.notificationFinishedLabel'),
    });
    expect(finished).toBeDisabled();
    // 两个事件开关的描述都切换为引导文案
    expect(screen.getAllByText(t('settings.notificationDisabledDesc'))).toHaveLength(2);
    // 总开关状态进 store（写穿透由 store 层测试覆盖，此处断言 UI 联动实质）
    expect(useSettingsStore.getState().notification.enabled).toBe(false);
  });

  it('toggle 出错开关 → store 部分合并 + 以 notification 键写穿透', async () => {
    render(<NotificationSection />);

    await userEvent.click(
      screen.getByRole('switch', { name: t('settings.notificationFailedLabel') }),
    );

    expect(useSettingsStore.getState().notification).toEqual({
      enabled: true,
      onTurnFinished: true,
      onTurnFailed: false,
    });
    const calls = setSpy.mock.calls as unknown as { key: string }[][];
    const writes = calls.filter((c) => c[0]?.key === 'notification');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toEqual({
      key: 'notification',
      value: { enabled: true, onTurnFinished: true, onTurnFailed: false },
    });
  });

  it('V9 值保留：总开关关时事件开关值不变，恢复总开关后原值生效', async () => {
    // 预置：出错关、完成开
    useSettingsStore.setState({
      notification: { enabled: false, onTurnFinished: true, onTurnFailed: false },
    });
    render(<NotificationSection />);

    await userEvent.click(screen.getByRole('switch', { name: t('settings.notificationLabel') }));

    expect(useSettingsStore.getState().notification).toEqual({
      enabled: true,
      onTurnFinished: true,
      onTurnFailed: false,
    });
  });
});
