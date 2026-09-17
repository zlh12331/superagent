// src/renderer/components/layout/__tests__/layout-gaps.test.tsx
// layout 域批次7 缺口补全：Topbar 主题切换/设置/面板隐藏/折叠态文案
//
// 测试要点（现有 Topbar.test.tsx 已覆盖侧栏/命令面板/右面板/返回）：
// 主题切换按钮（setTheme + 图标切换）、设置按钮（openSettings）、
// hideRightPanelToggle 隐藏右面板开关、折叠态 aria-label 变化

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/providers/ThemeProvider';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { Topbar } from './Topbar';

describe('layout 批次7 缺口补全', () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ theme: 'dark' });
  });

  function renderTopbar(props: Partial<Parameters<typeof Topbar>[0]> = {}) {
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
    renderTopbar();
    fireEvent.click(screen.getByLabelText('切换主题'));
    expect(useSettingsStore.getState().theme).toBe('light');
  });

  it('主题切换按钮：dark 主题显示太阳图标（切换为亮色）', () => {
    renderTopbar();
    // dark → 显示 Sun（点击切到 light）
    expect(document.querySelector('.lucide-sun')).not.toBeNull();
  });

  it('主题切换按钮：light 主题显示月亮图标', () => {
    useSettingsStore.setState({ theme: 'light' });
    renderTopbar();
    expect(document.querySelector('.lucide-moon')).not.toBeNull();
  });

  it('设置按钮已删除：顶栏不再渲染设置入口（入口在命令面板/账户菜单）', () => {
    renderTopbar();
    expect(screen.queryByLabelText('设置')).toBeNull();
  });

  it('hideRightPanelToggle：隐藏右面板开关', () => {
    renderTopbar({ hideRightPanelToggle: true });
    expect(screen.queryByLabelText('折叠右侧面板')).toBeNull();
    expect(screen.queryByLabelText('展开右侧面板')).toBeNull();
  });

  it('侧栏折叠态：aria-label 切换为展开文案', () => {
    renderTopbar({ sidebarCollapsed: true });
    expect(screen.getByLabelText('展开侧边栏')).toBeDefined();
    expect(screen.getByLabelText('展开侧边栏').getAttribute('aria-expanded')).toBe('false');
  });

  it('右面板折叠态：aria-label 切换为展开文案', () => {
    renderTopbar({ rightPanelCollapsed: true });
    expect(screen.getByLabelText('展开右侧面板')).toBeDefined();
  });
});
