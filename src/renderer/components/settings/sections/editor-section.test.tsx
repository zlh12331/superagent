import { EDITOR_TAB_SIZES } from '@code-agent/shared/renderer';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/persistent/settings-store';

import { EditorSection } from './editor-section';

const t = i18n.t.bind(i18n);

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState((s) => ({
    editor: { ...s.editor, fontSize: 14, vimMode: false, wordWrap: false, tabSize: 8 },
  }));
});

describe('EditorSection', () => {
  it('正向：切换字号 → updateEditor 写 store', async () => {
    render(<EditorSection />);

    const items = screen.getAllByRole('radio');
    const sixteen = items.find((el) => el.textContent === '16');
    await userEvent.click(sixteen as HTMLElement);

    expect(useSettingsStore.getState().editor.fontSize).toBe(16);
  });

  it('正向：vim 开关 → 写入 store', async () => {
    render(<EditorSection />);

    await userEvent.click(screen.getByRole('switch', { name: t('settings.editor.vimMode') }));

    expect(useSettingsStore.getState().editor.vimMode).toBe(true);
  });

  it('37-A：自动换行开关 → 写入 store', async () => {
    render(<EditorSection />);

    await userEvent.click(screen.getByRole('switch', { name: t('settings.editor.wordWrap') }));

    expect(useSettingsStore.getState().editor.wordWrap).toBe(true);
  });

  it('37-A：Tab 宽度档位与 EDITOR_TAB_SIZES 一一对应，切换写 store', async () => {
    render(<EditorSection />);

    for (const size of EDITOR_TAB_SIZES) {
      expect(screen.getByRole('radio', { name: String(size) })).toBeDefined();
    }
    await userEvent.click(screen.getByRole('radio', { name: '4' }));
    expect(useSettingsStore.getState().editor.tabSize).toBe(4);
  });

  it('SegControl 回归：点击已选中字号（14）→ 字号保持 14，不被写成 0', async () => {
    render(<EditorSection />);
    const items = screen.getAllByRole('radio');
    const fourteen = items.find((el) => el.textContent === '14');
    expect(fourteen).toBeDefined();
    await userEvent.click(fourteen as HTMLElement);

    expect(useSettingsStore.getState().editor.fontSize).toBe(14);
  });

  it('SegControl 回归：切换到另一档位仍正常写入（修复未破坏正常路径）', async () => {
    render(<EditorSection />);
    const items = screen.getAllByRole('radio');
    const sixteen = items.find((el) => el.textContent === '16');
    await userEvent.click(sixteen as HTMLElement);

    expect(useSettingsStore.getState().editor.fontSize).toBe(16);
  });
});
