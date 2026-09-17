// src/renderer/components/$1/layout-utils.test.ts
// 面板宽度纯函数测试（正向 / 边界 / 异常）
// ──────────────────────────────────────────────────────────────
// 覆盖此前基本无覆盖的 parseClamp（内联在 layout-utils 的 CSS 令牌桥）：
// 设计原则是「CSS 自定义属性是宽度唯一数据源」，JS 从 clamp() 字符串解析出
// min/max/首选比例——故解析失败必须**静默回退到与 aurora.json 对齐的安全值**，
// 绝不能抛错或产出 NaN（否则拖拽上下限变成 NaN，clamp 失效）。
//
// 测试要点：
// 1. 正向：合法 clamp(px, vw, px) → 解析出正确上下限并参与计算
// 2. 容错：空格变体 / 大写 CLAMP 均可解析
// 3. 回退：变量缺失 / 非 clamp 格式 / 单位不符 / 数字非法 → 安全默认值
// 4. 边界：resolveClamp 的三段语义（低于 min / 区间内 / 高于 max）
// ──────────────────────────────────────────────────────────────

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
    // 1000px 视口 × 20vw = 200px，落在 [150, 400] 内
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
    // 100px 视口 × 1vw = 1px，低于 min 150
    stubComputedStyle({ '--sidebar-w': 'clamp(150px, 1vw, 400px)' });
    stubViewport(100);

    expect(computeInitialSidebarWidth()).toBe(150);
  });

  it('边界：首选值高于上限 → 取上限', () => {
    // 5000px × 90vw = 4500px，高于 max 400
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
    // 1000 × 20.55vw = 205.5 → 206
    stubComputedStyle({ '--sidebar-w': 'clamp(150px, 20.55vw, 400px)' });
    stubViewport(1000);

    expect(computeInitialSidebarWidth()).toBe(206);
  });

  describe('异常：解析失败一律回退安全默认值（不抛错、不产出 NaN）', () => {
    it('变量缺失（空串）→ 回退', () => {
      stubComputedStyle({});
      stubViewport(1440);

      // 回退值 {200,280,0.17} → 1440×0.17=244.8 → 245
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

      // 右面板回退 {260,360,0.22} → clamp(260, 1440×0.22=316.8, 360) = 316.8 → 317
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
