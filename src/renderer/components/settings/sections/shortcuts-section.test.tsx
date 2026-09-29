// src/renderer/components/settings/sections/shortcuts-section.test.tsx
// ShortcutsSection 测试：快捷键行渲染 + 冲突拒绝 + 恢复默认（36 号 C）
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { DEFAULT_SHORTCUTS, useSettingsStore } from '@/stores/persistent/settings-store';

import { ShortcutsSection } from './shortcuts-section';

const t = i18n.t.bind(i18n);

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

const setSpy = vi.fn(async () => ({ data: { ok: true } }));

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'api', {
    value: { settings: { set: setSpy } },
    writable: true,
    configurable: true,
  });
  setSpy.mockClear();
  // 复位快捷键到默认（store 是跨测试共享的单例；不能 spread 现值——上个测试的
  // 自定义值会泄漏进后续用例）
  useSettingsStore.getState().updateShortcuts({ ...DEFAULT_SHORTCUTS });
});

/** 录制流程：点击录键控件（进入录制态）→ 在 window 上派发按键组合 */
async function record(combo: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): Promise<void> {
  await userEvent.click(screen.getAllByRole('button', { name: 'Ctrl+P' })[0] as HTMLElement);
  fireEvent.keyDown(window, combo);
}

describe('ShortcutsSection', () => {
  it('正向：渲染六个录键控件 + 恢复默认按钮（默认值时禁用）', () => {
    render(<ShortcutsSection />);

    // 6 个 ShortcutPicker + 1 个「恢复默认快捷键」按钮
    expect(screen.getAllByRole('button')).toHaveLength(7);
    expect(
      (screen.getByRole('button', { name: t('settings.shortcutResetAll') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('边界：已绑定键显示键名，未绑定显示占位文案', () => {
    useSettingsStore.setState((s) => ({
      shortcuts: { ...s.shortcuts, saveFile: '' },
    }));
    render(<ShortcutsSection />);

    expect(screen.getByText(t('settings.shortcutUnbound'))).toBeDefined();
  });

  it('V1 与其他自定义键冲突 → toast 指明冲突动作，store 不写', async () => {
    render(<ShortcutsSection />);

    // commandPalette 行录入 Ctrl+S（已被 saveFile 占用）
    await record({ key: 's', ctrlKey: true });

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().shortcuts.commandPalette).toBe('Ctrl+P');
  });

  it('V2 与固定键冲突（Ctrl+B）→ toast，store 不写', async () => {
    render(<ShortcutsSection />);

    await record({ key: 'b', ctrlKey: true });

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().shortcuts.commandPalette).toBe('Ctrl+P');
  });

  it('无冲突录入 → 写穿透（对照组）', async () => {
    render(<ShortcutsSection />);

    // Ctrl+E 不与任何自定义键/固定键冲突
    await record({ key: 'e', ctrlKey: true });

    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().shortcuts.commandPalette).toBe('Ctrl+E');
  });

  it('V6 单键恢复默认：与默认值不同时显示重置钮，点击还原', async () => {
    useSettingsStore.setState((s) => ({
      shortcuts: { ...s.shortcuts, commandPalette: 'Ctrl+J' },
    }));
    render(<ShortcutsSection />);

    const resetButtons = screen.getAllByRole('button', { name: t('settings.shortcutResetKey') });
    expect(resetButtons).toHaveLength(1);
    await userEvent.click(resetButtons[0] as HTMLElement);

    expect(useSettingsStore.getState().shortcuts.commandPalette).toBe('Ctrl+P');
  });

  it('V7 一键全部恢复默认：confirm 放行后写回默认值', async () => {
    useSettingsStore.setState((s) => ({
      shortcuts: { ...s.shortcuts, commandPalette: 'Ctrl+J', saveFile: '' },
    }));
    render(<ShortcutsSection />);

    await userEvent.click(
      screen.getByRole('button', { name: t('settings.shortcutResetAll') }) as HTMLElement,
    );
    // 危险操作先确认：confirm store（DialogHost 未挂载 → 手动放行）
    const { useConfirmDialogStore } = await import('@/stores/transient/confirm-dialog-store');
    await waitFor(() => expect(useConfirmDialogStore.getState().currentRequest).not.toBeNull());
    useConfirmDialogStore.getState()._resolve(true);

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledTimes(1));
    expect(useSettingsStore.getState().shortcuts.commandPalette).toBe('Ctrl+P');
    expect(useSettingsStore.getState().shortcuts.saveFile).toBe('Ctrl+S');
  });

  it('V7 拒绝确认 → 不写', async () => {
    useSettingsStore.setState((s) => ({
      shortcuts: { ...s.shortcuts, commandPalette: 'Ctrl+J' },
    }));
    render(<ShortcutsSection />);

    await userEvent.click(
      screen.getByRole('button', { name: t('settings.shortcutResetAll') }) as HTMLElement,
    );
    const { useConfirmDialogStore } = await import('@/stores/transient/confirm-dialog-store');
    await waitFor(() => expect(useConfirmDialogStore.getState().currentRequest).not.toBeNull());
    useConfirmDialogStore.getState()._resolve(false);

    await waitFor(() => expect(useConfirmDialogStore.getState().currentRequest).toBeNull());
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().shortcuts.commandPalette).toBe('Ctrl+J');
  });
});
