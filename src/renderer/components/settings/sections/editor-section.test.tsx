// src/renderer/components/settings/sections/editor-section.test.tsx
// EditorSection 测试：字号/开关写 store + SegControl 消费方回归
// ──────────────────────────────────────────────────────────────
// SegControl 回归背景（2026-09 审计）：SegControl 曾把 Radix 的「反选空串」
// 透传给 onChange，消费方 `Number(value)` 写库会把字号写成 0，且受控值变 '0'
// 后无选项匹配、控件显示「什么都没选」。此处锁定端到端：点击已选项不改写设置。
// ──────────────────────────────────────────────────────────────

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/persistent/settings-store';

import { EditorSection } from './editor-section';

const t = i18n.t.bind(i18n);

beforeEach(() => {
  vi.clearAllMocks();
  // 还原为出厂默认（字号 14）
  useSettingsStore.setState((s) => ({
    editor: { ...s.editor, fontSize: 14, vimMode: false },
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

  it('SegControl 回归：点击已选中字号（14）→ 字号保持 14，不被写成 0', async () => {
    render(<EditorSection />);
    // 当前值 14 已选中；再点一次（Radix 会触发反选空串）
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
