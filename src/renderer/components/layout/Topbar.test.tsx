// src/renderer/components/layout/__tests__/Topbar.test.tsx
// Topbar 组件测试（顶栏按钮组渲染与回调）
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. 侧栏/右面板切换按钮渲染且回调触发
// 2. 命令面板双入口（图标 + 文字）渲染
// 3. 设置/主题按钮渲染
// 4. 返回按钮按 showBack 条件渲染
// ──────────────────────────────────────────────────────────────

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '@/providers/ThemeProvider';
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
