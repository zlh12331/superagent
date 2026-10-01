// src/renderer/components/settings/sections/terminal-section.test.tsx
// TerminalSection 测试：断言 store 实质状态（36 号 B：选项表随平台 + 写穿透）
// ──────────────────────────────────────────────────────────────
// jsdom navigator.platform 为空串 → 归一 linux 分支（auto/bash/zsh/fish）。
// 覆盖：
// - shell 选项随平台档位表渲染（linux 分支）且当前值命中
// - fontSize 档位 = TERMINAL_FONT_SIZES
// - 切换 shell / 字号 → updateTerminal 部分合并 + 以 terminal 键写穿透
// ──────────────────────────────────────────────────────────────

import { TERMINAL_FONT_SIZES } from '@code-agent/shared/renderer';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/persistent/settings-store';

import { TerminalSection } from './terminal-section';

const setSpy = vi.fn(async () => ({ data: { ok: true } }));

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'api', {
    value: { settings: { set: setSpy } },
    writable: true,
    configurable: true,
  });
  useSettingsStore.setState({ terminal: { shell: 'auto', fontSize: 13 } });
});

describe('TerminalSection', () => {
  it('shell 选项随平台档位表渲染（jsdom = linux 分支）且当前值命中', () => {
    render(<TerminalSection />);

    // SegControl 迁 ToggleGroup：item 是 radio 语义（激活态 data-state=on）
    // jsdom 下 navigator.platform 为空 → linux 选项表
    for (const label of ['Auto', 'Bash', 'Zsh', 'Fish']) {
      expect(screen.getByRole('radio', { name: label })).toBeDefined();
    }
    // windows 独有档位不可见
    expect(screen.queryByRole('radio', { name: 'WSL' })).toBeNull();
    // 当前值 auto 高亮
    expect(screen.getByRole('radio', { name: 'Auto' }).getAttribute('data-state')).toBe('on');
  });

  it('fontSize 档位与 TERMINAL_FONT_SIZES 一一对应', () => {
    render(<TerminalSection />);

    for (const size of TERMINAL_FONT_SIZES) {
      expect(screen.getByRole('radio', { name: String(size) })).toBeDefined();
    }
  });

  it('切换 shell → store 部分合并 + 以 terminal 键写穿透', async () => {
    render(<TerminalSection />);

    await userEvent.click(screen.getByRole('radio', { name: 'Bash' }));

    expect(useSettingsStore.getState().terminal.shell).toBe('bash');
    expect(useSettingsStore.getState().terminal.fontSize).toBe(13);
    const calls = setSpy.mock.calls as unknown as { key: string }[][];
    const writes = calls.filter((c) => c[0]?.key === 'terminal');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toEqual({ key: 'terminal', value: { shell: 'bash', fontSize: 13 } });
  });

  it('切换字号 → store 部分合并 + 写穿透', async () => {
    render(<TerminalSection />);

    await userEvent.click(screen.getByRole('radio', { name: '16' }));

    expect(useSettingsStore.getState().terminal.fontSize).toBe(16);
    const calls = setSpy.mock.calls as unknown as { key: string }[][];
    const writes = calls.filter((c) => c[0]?.key === 'terminal');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toEqual({ key: 'terminal', value: { shell: 'auto', fontSize: 16 } });
  });
});
