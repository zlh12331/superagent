import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeInitialRightPanelWidth,
  computeInitialSidebarWidth,
  RIGHT_PANEL_WIDTH_MAX,
  RIGHT_PANEL_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from './layout-utils';

/** 让 getComputedStyle 对给定变量返回指定原始值（其余返回空串） */
function stubComputedStyle(values: Record<string, string>): void {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    () =>
      ({
        getPropertyValue: (name: string) => values[name] ?? '',
      }) as unknown as CSSStyleDeclaration,
  );
}

/** 设置视口宽度（jsdom 的 innerWidth 可写） */
function stubViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
}

describe('computeInitialSidebarWidth / computeInitialRightPanelWidth', () => {
  beforeEach(() => {
    stubViewport(1440);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('正向：从 CSS 令牌解析 clamp 并按视口计算（区间内取首选值）', () => {
    stubComputedStyle({ '--sidebar-w': 'clamp(150px, 20vw, 400px)' });
    stubViewport(1000);

    expect(computeInitialSidebarWidth()).toBe(200);
  });

  it('正向：右面板独立解析各自的令牌', () => {
    stubComputedStyle({ '--right-panel-w': 'clamp(200px, 30vw, 500px)' });
    stubViewport(1000);

    expect(computeInitialRightPanelWidth()).toBe(300);
  });

  it('边界：首选值低于下限 → 取下限', () => {
    stubComputedStyle({ '--sidebar-w': 'clamp(150px, 1vw, 400px)' });
    stubViewport(100);

    expect(computeInitialSidebarWidth()).toBe(150);
  });

  it('边界：首选值高于上限 → 取上限', () => {
    stubComputedStyle({ '--sidebar-w': 'clamp(150px, 90vw, 400px)' });
    stubViewport(5000);

    expect(computeInitialSidebarWidth()).toBe(400);
  });

  it('容错：无空格写法与大小写均可解析', () => {
    stubComputedStyle({ '--sidebar-w': 'CLAMP(150px,20vw,400px)' });
    stubViewport(1000);

    expect(computeInitialSidebarWidth()).toBe(200);
  });

  it('边界：结果取整（Math.round）', () => {
    stubComputedStyle({ '--sidebar-w': 'clamp(150px, 20.55vw, 400px)' });
    stubViewport(1000);

    expect(computeInitialSidebarWidth()).toBe(206);
  });

  describe('异常：解析失败一律回退安全默认值（不抛错、不产出 NaN）', () => {
    it('变量缺失（空串）→ 回退', () => {
      stubComputedStyle({});
      stubViewport(1440);

      const width = computeInitialSidebarWidth();
      expect(width).toBe(245);
      expect(Number.isNaN(width)).toBe(false);
    });

    it('非 clamp 格式（如裸 px）→ 回退', () => {
      stubComputedStyle({ '--sidebar-w': '240px' });
      stubViewport(1440);

      expect(computeInitialSidebarWidth()).toBe(245);
    });

    it('单位不符（rem/% 而非 px+vw+px）→ 回退', () => {
      stubComputedStyle({ '--sidebar-w': 'clamp(10rem, 20%, 40rem)' });
      stubViewport(1440);

      expect(computeInitialSidebarWidth()).toBe(245);
    });

    it('缺参数（clamp 只有两段）→ 回退', () => {
      stubComputedStyle({ '--sidebar-w': 'clamp(150px, 400px)' });
      stubViewport(1440);

      expect(computeInitialSidebarWidth()).toBe(245);
    });

    it('右面板令牌非法时同样回退到右面板默认（互不串用）', () => {
      stubComputedStyle({ '--right-panel-w': 'garbage' });
      stubViewport(1440);

      expect(computeInitialRightPanelWidth()).toBe(317);
    });
  });

  describe('导出常量与令牌对齐', () => {
    it('上下限为有限正数（解析失败时不得为 NaN，否则 clamp 失效）', () => {
      stubComputedStyle({});
      for (const v of [
        SIDEBAR_WIDTH_MIN,
        SIDEBAR_WIDTH_MAX,
        RIGHT_PANEL_WIDTH_MIN,
        RIGHT_PANEL_WIDTH_MAX,
      ]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
    });

    it('下限严格小于上限（区间有效）', () => {
      expect(SIDEBAR_WIDTH_MIN).toBeLessThan(SIDEBAR_WIDTH_MAX);
      expect(RIGHT_PANEL_WIDTH_MIN).toBeLessThan(RIGHT_PANEL_WIDTH_MAX);
    });
  });
});
