// src/renderer/components/$1/Topbar.test.tsx
// Topbar 组件测试（顶栏按钮组渲染与回调）
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. 侧栏/右面板切换按钮渲染且回调触发
// 2. 命令面板双入口（图标 + 文字）渲染
// 3. 设置/主题按钮渲染
// 4. 返回按钮按 showBack 条件渲染
// ──────────────────────────────────────────────────────────────

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '@/providers/ThemeProvider';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { Topbar } from './Topbar';

/** 渲染 Topbar（ThemeProvider 包裹，useTheme 真实实现） */
function renderTopbar(props: Partial<Parameters<typeof Topbar>[0]> = {}) {
  const handlers = {
    onToggleSidebar: vi.fn(),
    onToggleRightPanel: vi.fn(),
    onOpenCommandPalette: vi.fn(),
  };
  render(
    <ThemeProvider>
      <Topbar sidebarCollapsed={false} rightPanelCollapsed={false} {...handlers} {...props} />
    </ThemeProvider>,
  );
  return handlers;
}

describe('Topbar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('渲染侧栏/右面板切换按钮并触发回调', async () => {
    const handlers = renderTopbar();
    await userEvent.click(screen.getByRole('button', { name: /折叠侧边栏|展开侧边栏/ }));
    expect(handlers.onToggleSidebar).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: /折叠右侧面板|展开右侧面板/ }));
    expect(handlers.onToggleRightPanel).toHaveBeenCalledTimes(1);
  });

  it('命令面板单一入口（文字胶囊）：点击触发 onOpenCommandPalette', async () => {
    const handlers = renderTopbar();
    const paletteButtons = screen.getAllByRole('button', { name: /命令面板/ });
    // 单一入口：重复的图标按钮已删除（对齐原型 palette-entry-btn）
    expect(paletteButtons.length).toBe(1);
    const first = paletteButtons[0];
    if (first === undefined) {
      throw new Error('命令面板按钮缺失');
    }
    await userEvent.click(first);
    expect(handlers.onOpenCommandPalette).toHaveBeenCalledTimes(1);
  });

  it('渲染主题切换按钮（设置按钮已删除）', () => {
    renderTopbar();
    expect(screen.getByRole('button', { name: /切换主题|主题/ })).toBeTruthy();
  });
});

// ── 主题切换 / 面板隐藏 / 折叠态文案（原 layout-gaps.test 并入） ──
describe('Topbar · 主题切换与折叠态', () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ theme: 'dark' });
  });

  function renderTopbarThemed(props: Partial<Parameters<typeof Topbar>[0]> = {}) {
    return render(
      <ThemeProvider>
        <Topbar
          sidebarCollapsed={false}
          onToggleSidebar={vi.fn()}
          rightPanelCollapsed={false}
          onToggleRightPanel={vi.fn()}
          onOpenCommandPalette={vi.fn()}
          {...props}
        />
      </ThemeProvider>,
    );
  }

  it('主题切换：dark 时点击 → light，settings-store 更新', () => {
    renderTopbarThemed();
    fireEvent.click(screen.getByLabelText('切换主题'));
    expect(useSettingsStore.getState().theme).toBe('light');
  });

  it('主题切换按钮：dark 主题显示太阳图标（切换为亮色）', () => {
    renderTopbarThemed();
    // dark → 显示 Sun（点击切到 light）
    expect(document.querySelector('.lucide-sun')).not.toBeNull();
  });

  it('主题切换按钮：light 主题显示月亮图标', () => {
    useSettingsStore.setState({ theme: 'light' });
    renderTopbarThemed();
    expect(document.querySelector('.lucide-moon')).not.toBeNull();
  });

  it('设置按钮已删除：顶栏不再渲染设置入口（入口在命令面板/账户菜单）', () => {
    renderTopbarThemed();
    expect(screen.queryByLabelText('设置')).toBeNull();
  });

  it('hideRightPanelToggle：隐藏右面板开关', () => {
    renderTopbarThemed({ hideRightPanelToggle: true });
    expect(screen.queryByLabelText('折叠右侧面板')).toBeNull();
    expect(screen.queryByLabelText('展开右侧面板')).toBeNull();
  });

  it('侧栏折叠态：aria-label 切换为展开文案', () => {
    renderTopbarThemed({ sidebarCollapsed: true });
    expect(screen.getByLabelText('展开侧边栏')).toBeDefined();
    expect(screen.getByLabelText('展开侧边栏').getAttribute('aria-expanded')).toBe('false');
  });

  it('右面板折叠态：aria-label 切换为展开文案', () => {
    renderTopbarThemed({ rightPanelCollapsed: true });
    expect(screen.getByLabelText('展开右侧面板')).toBeDefined();
  });
});
