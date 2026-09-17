// src/renderer/hooks/__tests__/use-resizable-panels.test.tsx
// 面板宽度与分隔线交互测试（正向 / 边界 / 异常）
// ──────────────────────────────────────────────────────────────
// 该逻辑此前内联在 AppShell（约 100 行、5 个 state/ref/callback + 3 个 effect），
// 是 AppShell 认知复杂度 25 的基线条目主因；提取后首次获得独立覆盖。
//
// 测试要点：
// 1. 拖拽：mousedown 后按 clientX 位移调整宽度，且 clamp 在令牌上下限内
// 2. 左右方向语义：左侧右移变宽；右侧右移**变窄**（符号相反）
// 3. 键盘：←/→ 16px 步进、Home/End 跳极值；无关键不拦截
// 4. 折叠联动：CSS 变量置 0px
// 5. 清理：mouseup 与卸载都移除全局监听、去掉 body.resizing
// ──────────────────────────────────────────────────────────────

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RIGHT_PANEL_WIDTH_MAX,
  RIGHT_PANEL_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from '@/components/layout/layout-utils';

import { useResizablePanels } from '../use-resizable-panels';

/** 构造最小可用的 mousedown 事件（只需 preventDefault + clientX） */
function mouseDownEvent(clientX: number): {
  preventDefault: () => void;
  clientX: number;
} {
  return { preventDefault: vi.fn(), clientX };
}

/** 构造最小可用的 keydown 事件 */
function keyDownEvent(key: string): {
  key: string;
  preventDefault: () => void;
  stopPropagation: () => void;
} {
  return { key, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

describe('useResizablePanels', () => {
  beforeEach(() => {
    document.body.className = '';
  });

  afterEach(() => {
    document.body.className = '';
    vi.restoreAllMocks();
  });

  describe('初始值', () => {
    it('宽度来自 CSS 令牌解析（clamp 结果，落在上下限内）', () => {
      const { result } = renderHook(() => useResizablePanels(false, false));
      expect(result.current.sidebarWidth).toBeGreaterThanOrEqual(SIDEBAR_WIDTH_MIN);
      expect(result.current.sidebarWidth).toBeLessThanOrEqual(SIDEBAR_WIDTH_MAX);
      expect(result.current.rightPanelWidth).toBeGreaterThanOrEqual(RIGHT_PANEL_WIDTH_MIN);
      expect(result.current.rightPanelWidth).toBeLessThanOrEqual(RIGHT_PANEL_WIDTH_MAX);
      expect(result.current.draggingSide).toBeNull();
    });
  });

  describe('拖拽（正向 / 方向语义 / clamp）', () => {
    it('左分隔线右移 → 侧栏变宽（按位移累加）', () => {
      const { result } = renderHook(() => useResizablePanels(false, false));
      const start = result.current.sidebarWidth;

      act(() => {
        result.current.onResizerMouseDown('left')(
          mouseDownEvent(100) as unknown as React.MouseEvent<HTMLHRElement>,
        );
      });
      expect(result.current.draggingSide).toBe('left');
      expect(document.body.classList.contains('resizing')).toBe(true);

      act(() => {
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 140 }));
      });
      expect(result.current.sidebarWidth).toBe(Math.min(start + 40, SIDEBAR_WIDTH_MAX));
    });

    it('右分隔线右移 → 面板**变窄**（符号相反，对齐拖拽直觉）', () => {
      const { result } = renderHook(() => useResizablePanels(false, false));
      const start = result.current.rightPanelWidth;

      act(() => {
        result.current.onResizerMouseDown('right')(
          mouseDownEvent(300) as unknown as React.MouseEvent<HTMLHRElement>,
        );
      });
      act(() => {
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 340 }));
      });

      // 右移 40px → 宽度减少 40（且不低于下限）
      expect(result.current.rightPanelWidth).toBe(Math.max(start - 40, RIGHT_PANEL_WIDTH_MIN));
    });

    it('边界：拖到远超上限 → clamp 在上限，不越界', () => {
      const { result } = renderHook(() => useResizablePanels(false, false));
      act(() => {
        result.current.onResizerMouseDown('left')(
          mouseDownEvent(0) as unknown as React.MouseEvent<HTMLHRElement>,
        );
      });
      act(() => {
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 99999 }));
      });
      expect(result.current.sidebarWidth).toBe(SIDEBAR_WIDTH_MAX);
    });

    it('边界：拖到远超下限 → clamp 在下限，不越界', () => {
      const { result } = renderHook(() => useResizablePanels(false, false));
      act(() => {
        result.current.onResizerMouseDown('left')(
          mouseDownEvent(99999) as unknown as React.MouseEvent<HTMLHRElement>,
        );
      });
      act(() => {
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: -99999 }));
      });
      expect(result.current.sidebarWidth).toBe(SIDEBAR_WIDTH_MIN);
    });

    it('异常：未 mousedown 时 mousemove 不改变宽度（dragStart 为 null）', () => {
      const { result } = renderHook(() => useResizablePanels(false, false));
      const before = result.current.sidebarWidth;

      act(() => {
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 }));
      });
      expect(result.current.sidebarWidth).toBe(before);
    });

    it('mouseup：结束拖拽、移除 resizing 类与全局监听', () => {
      const { result } = renderHook(() => useResizablePanels(false, false));
      act(() => {
        result.current.onResizerMouseDown('left')(
          mouseDownEvent(100) as unknown as React.MouseEvent<HTMLHRElement>,
        );
      });

      act(() => {
        document.dispatchEvent(new MouseEvent('mouseup'));
      });
      expect(result.current.draggingSide).toBeNull();
      expect(document.body.classList.contains('resizing')).toBe(false);

      // 结束后 mousemove 不应再改变宽度
      const after = result.current.sidebarWidth;
      act(() => {
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 900 }));
      });
      expect(result.current.sidebarWidth).toBe(after);
    });
  });

  describe('键盘调整', () => {
    it('→ 步进加宽（左侧），← 步进收窄', () => {
      const { result } = renderHook(() => useResizablePanels(false, false));
      const start = result.current.sidebarWidth;

      act(() => {
        result.current.onResizerKeyDown('left')(
          keyDownEvent('ArrowRight') as unknown as React.KeyboardEvent<HTMLHRElement>,
        );
      });
      const widened = result.current.sidebarWidth;
      expect(widened).toBe(Math.min(start + 16, SIDEBAR_WIDTH_MAX));

      act(() => {
        result.current.onResizerKeyDown('left')(
          keyDownEvent('ArrowLeft') as unknown as React.KeyboardEvent<HTMLHRElement>,
        );
      });
      expect(result.current.sidebarWidth).toBe(Math.max(widened - 16, SIDEBAR_WIDTH_MIN));
    });

    it('边界：Home/End 跳到极值', () => {
      const { result } = renderHook(() => useResizablePanels(false, false));
      act(() => {
        result.current.onResizerKeyDown('left')(
          keyDownEvent('Home') as unknown as React.KeyboardEvent<HTMLHRElement>,
        );
      });
      expect(result.current.sidebarWidth).toBe(SIDEBAR_WIDTH_MIN);

      act(() => {
        result.current.onResizerKeyDown('left')(
          keyDownEvent('End') as unknown as React.KeyboardEvent<HTMLHRElement>,
        );
      });
      expect(result.current.sidebarWidth).toBe(SIDEBAR_WIDTH_MAX);
    });

    it('边界：无关按键不拦截（不 preventDefault/stopPropagation）', () => {
      const { result } = renderHook(() => useResizablePanels(false, false));
      const event = keyDownEvent('a');
      act(() => {
        result.current.onResizerKeyDown('left')(
          event as unknown as React.KeyboardEvent<HTMLHRElement>,
        );
      });
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
    });

    it('方向键会拦截默认行为（避免页面滚动）', () => {
      const { result } = renderHook(() => useResizablePanels(false, false));
      const event = keyDownEvent('ArrowRight');
      act(() => {
        result.current.onResizerKeyDown('left')(
          event as unknown as React.KeyboardEvent<HTMLHRElement>,
        );
      });
      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
    });
  });

  describe('折叠联动（CSS 变量）', () => {
    it('展开态：变量写实际宽度', () => {
      renderHook(() => useResizablePanels(false, false));
      const root = document.documentElement;
      expect(root.style.getPropertyValue('--aurora-sidebar-w')).toMatch(/^\d+px$/);
      expect(root.style.getPropertyValue('--aurora-right-panel-w')).toMatch(/^\d+px$/);
    });

    it('折叠态：变量置 0px（grid 列塌缩）', () => {
      renderHook(() => useResizablePanels(true, true));
      const root = document.documentElement;
      expect(root.style.getPropertyValue('--aurora-sidebar-w')).toBe('0px');
      expect(root.style.getPropertyValue('--aurora-right-panel-w')).toBe('0px');
    });
  });

  describe('清理', () => {
    it('异常：拖拽中卸载 → 移除 resizing 类（不留全局状态）', () => {
      const { result, unmount } = renderHook(() => useResizablePanels(false, false));
      act(() => {
        result.current.onResizerMouseDown('left')(
          mouseDownEvent(100) as unknown as React.MouseEvent<HTMLHRElement>,
        );
      });
      expect(document.body.classList.contains('resizing')).toBe(true);

      unmount();
      expect(document.body.classList.contains('resizing')).toBe(false);
    });
  });
});
