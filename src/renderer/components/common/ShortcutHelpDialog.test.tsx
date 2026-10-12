import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { useUiStore } from '@/stores/transient/ui-store';

import { ShortcutHelpDialog } from './ShortcutHelpDialog';

const t = i18n.t.bind(i18n);

const ORIGINAL = useSettingsStore.getState().shortcuts;

afterEach(() => {
  useSettingsStore.setState({ shortcuts: ORIGINAL });
  useUiStore.setState({ settingsOpen: false, settingsSection: null });
});

describe('ShortcutHelpDialog', () => {
  it('open=false：不渲染内容', () => {
    render(<ShortcutHelpDialog open={false} onClose={() => {}} />);
    expect(screen.queryByText(t('shortcutHelp.title'))).toBeNull();
  });

  it('正向：open=true → 渲染标题与固定快捷键（Ctrl + B / Enter / Esc）', () => {
    render(<ShortcutHelpDialog open onClose={() => {}} />);
    expect(screen.getAllByText(t('shortcutHelp.title')).length).toBeGreaterThan(0);
    expect(screen.getByText('Ctrl + B')).toBeDefined();
    expect(screen.getByText('Enter')).toBeDefined();
    expect(screen.getByText('Esc')).toBeDefined();
  });

  it('回归锚：自定义键位改动后帮助表跟随（此前硬编码导致与实际绑定不一致）', () => {
    useSettingsStore.setState({
      shortcuts: { ...ORIGINAL, openSettings: 'Ctrl+Alt+S' },
    });
    render(<ShortcutHelpDialog open onClose={() => {}} />);
    expect(screen.getByText('Ctrl + Alt + S')).toBeDefined();
  });

  it('键串格式化：+ 展开为 " + "（kbd 排版用），单键不产生多余空格', () => {
    useSettingsStore.setState({ shortcuts: { ...ORIGINAL, toggleTheme: 'Ctrl+Shift+T' } });
    render(<ShortcutHelpDialog open onClose={() => {}} />);
    expect(screen.getByText('Ctrl + Shift + T')).toBeDefined();
  });

  it('固定键与可自定义键共存：两者都在同一双列网格中', () => {
    render(<ShortcutHelpDialog open onClose={() => {}} />);
    expect(screen.getByText('? / F1')).toBeDefined();
    expect(screen.getByText('Shift + Enter')).toBeDefined();
    expect(screen.getByText(t('shortcutHelp.item.openSettings'), { exact: false })).toBeDefined();
  });

  it('直达入口：点「自定义快捷键」→ 打开设置并直达 shortcuts 分区 + 关闭本对话框', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ShortcutHelpDialog open onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: t('shortcutHelp.customize') }));

    const ui = useUiStore.getState();
    expect(ui.settingsOpen).toBe(true);
    expect(ui.settingsSection).toBe('shortcuts');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a11y：DialogDescription 提供 sr-only 描述（Radix 契约）', () => {
    render(<ShortcutHelpDialog open onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeDefined();
  });

  it('关闭交互：Esc 触发 Radix onOpenChange(false) → 调 onClose（此前分支未覆盖）', async () => {
    const onClose = vi.fn();
    render(<ShortcutHelpDialog open onClose={onClose} />);
    const dialog = screen.getByRole('dialog');

    await act(async () => {
      fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
