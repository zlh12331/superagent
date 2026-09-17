// src/renderer/components/terminal/TerminalTabs.test.tsx
// TerminalTabs 交互测试：tab 渲染/激活高亮/点击选择/键盘导航（方向键/Home/End）/关闭
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalMeta } from '@/stores/transient/terminal-store';
import { useTerminalStore } from '@/stores/transient/terminal-store';
import { TerminalTabs } from './TerminalTabs';

const terminals: readonly TerminalMeta[] = [
  { id: 't1', sessionId: 's1', title: 'zsh', pid: 1, cwd: '', alive: true, createdAt: 0 },
  { id: 't2', sessionId: 's1', title: '构建任务', pid: 2, cwd: '', alive: false, createdAt: 1 },
];

beforeEach(() => {
  vi.clearAllMocks();
  useTerminalStore.setState({ terminals: [], buffers: new Map() });
});

describe('TerminalTabs', () => {
  it('渲染 tab 列表 + 激活高亮 + 标题', () => {
    render(
      <TerminalTabs terminals={terminals} activeId="t1" onSelect={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('tablist')).toBeDefined();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false');
    expect(screen.getByText('zsh')).toBeDefined();
    expect(screen.getByText('构建任务')).toBeDefined();
  });

  it('点击 tab：触发 onSelect', () => {
    const onSelect = vi.fn();
    render(
      <TerminalTabs terminals={terminals} activeId="t1" onSelect={onSelect} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getAllByRole('tab')[1] as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith('t2');
  });

  it('键盘 Enter/Space：切换 tab；Delete/Backspace：关闭 tab', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <TerminalTabs terminals={terminals} activeId="t1" onSelect={onSelect} onClose={onClose} />,
    );
    const tab = screen.getAllByRole('tab')[1] as HTMLElement;
    fireEvent.keyDown(tab, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('t2');
    fireEvent.keyDown(tab, { key: ' ' });
    expect(onSelect).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(tab, { key: 'Delete' });
    expect(onClose).toHaveBeenCalledWith('t2');
    fireEvent.keyDown(tab, { key: 'Backspace' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('点击关闭按钮：onClose 且不触发 onSelect（stopPropagation）', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <TerminalTabs terminals={terminals} activeId="t1" onSelect={onSelect} onClose={onClose} />,
    );
    fireEvent.click(screen.getAllByLabelText('关闭终端')[0] as HTMLElement);
    expect(onClose).toHaveBeenCalledWith('t1');
    expect(onSelect).not.toHaveBeenCalled();
  });

  // ── 方向键导航（2026-09 审计补：a11y spec 明确要求 tablist 支持方向键，
  //    此前仅有 roving tabIndex 而无 Arrow 处理，键盘用户无法在 tab 间移动） ──

  it('ArrowRight：切换到下一个 tab', () => {
    const onSelect = vi.fn();
    render(
      <TerminalTabs terminals={terminals} activeId="t1" onSelect={onSelect} onClose={vi.fn()} />,
    );

    fireEvent.keyDown(screen.getAllByRole('tab')[0] as HTMLElement, { key: 'ArrowRight' });

    expect(onSelect).toHaveBeenCalledWith('t2');
  });

  it('ArrowLeft：从首项回绕到末项', () => {
    const onSelect = vi.fn();
    render(
      <TerminalTabs terminals={terminals} activeId="t1" onSelect={onSelect} onClose={vi.fn()} />,
    );

    fireEvent.keyDown(screen.getAllByRole('tab')[0] as HTMLElement, { key: 'ArrowLeft' });

    expect(onSelect).toHaveBeenCalledWith('t2');
  });

  it('Home/End：跳到首/末 tab', () => {
    const onSelect = vi.fn();
    render(
      <TerminalTabs terminals={terminals} activeId="t1" onSelect={onSelect} onClose={vi.fn()} />,
    );
    const tabs = screen.getAllByRole('tab');

    fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'End' });
    expect(onSelect).toHaveBeenLastCalledWith('t2');
    fireEvent.keyDown(tabs[1] as HTMLElement, { key: 'Home' });
    expect(onSelect).toHaveBeenLastCalledWith('t1');
  });

  it('方向键切换后焦点跟随激活项（roving tabindex 约定）', () => {
    render(
      <TerminalTabs terminals={terminals} activeId="t1" onSelect={vi.fn()} onClose={vi.fn()} />,
    );

    const first = screen.getAllByRole('tab')[0] as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });

    // 焦点须移到 t2 对应节点：否则焦点留在 tabIndex=-1 的旧节点，
    // 下次按 Tab 会直接跳过整个 tablist（键盘导航失效）
    expect(document.activeElement?.getAttribute('data-terminal-tab')).toBe('t2');
  });
});
