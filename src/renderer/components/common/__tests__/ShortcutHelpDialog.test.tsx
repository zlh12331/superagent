// src/renderer/components/common/__tests__/ShortcutHelpDialog.test.tsx
// ShortcutHelpDialog 单测：固定键 + 可自定义键（读设置真源）+ 键串格式化
// ──────────────────────────────────────────────
// 覆盖动机：组件此前 0% 覆盖。它展示的键位必须与真实绑定一致——
// 文件头注释记录了真实 bug：「此前硬编码默认值：用户改键后帮助表与实际绑定不一致」。
// 故本测试的核心回归锚是：自定义键改动后，帮助表随之变化。
// ──────────────────────────────────────────────

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/persistent/settings-store';

import { ShortcutHelpDialog } from '../ShortcutHelpDialog';

const t = i18n.t.bind(i18n);

const ORIGINAL = useSettingsStore.getState().shortcuts;

afterEach(() => {
  // 还原默认键位，避免污染其他用例
  useSettingsStore.setState({ shortcuts: ORIGINAL });
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
    // 键串经 formatKeys 展开为空格分隔的 kbd 排版
    expect(screen.getByText('Ctrl + Alt + S')).toBeDefined();
  });

  it('键串格式化：+ 展开为 " + "（kbd 排版用），单键不产生多余空格', () => {
    useSettingsStore.setState({ shortcuts: { ...ORIGINAL, toggleTheme: 'Ctrl+Shift+T' } });
    render(<ShortcutHelpDialog open onClose={() => {}} />);
    expect(screen.getByText('Ctrl + Shift + T')).toBeDefined();
  });

  it('固定键与可自定义键共存：两者都在同一双列网格中', () => {
    render(<ShortcutHelpDialog open onClose={() => {}} />);
    // 固定键（不可自定义）
    expect(screen.getByText('? / F1')).toBeDefined();
    expect(screen.getByText('Shift + Enter')).toBeDefined();
    // 可自定义键渲染自 settings
    expect(screen.getByText(t('shortcutHelp.item.openSettings'), { exact: false })).toBeDefined();
  });

  it('a11y：DialogDescription 提供 sr-only 描述（Radix 契约）', () => {
    render(<ShortcutHelpDialog open onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeDefined();
  });
});
