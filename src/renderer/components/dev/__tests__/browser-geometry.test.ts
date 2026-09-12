// src/renderer/components/dev/__tests__/browser-geometry.test.ts
// 浏览器预览几何纯函数单测：宿主占位区 + 设备预设 + 缩放 → 视图边界
//
// 关键语义：
// - 原生视图 bounds 不能超出宿主占位区（否则盖住面板外的其他 UI）→ clamp
// - rect=null 表示隐藏视图（面板隐藏 / 无 URL）
// - zoomFactor 语义：页面 CSS 视口 = bounds / zoomFactor
import { describe, expect, it } from 'vitest';

import { computeViewportLayout } from '../browser-geometry';

const HOST = { x: 800, y: 52, width: 400, height: 600 };

describe('computeViewportLayout', () => {
  it('hostRect=null → rect null（隐藏视图，zoomFactor 仍回传）', () => {
    expect(
      computeViewportLayout({
        hostRect: null,
        preset: 'responsive',
        deviceWidth: 0,
        deviceHeight: 0,
        zoom: 100,
      }),
    ).toEqual({ rect: null, zoomFactor: 1 });
  });

  it('宿主 0×0（DevPanel hidden 切换）→ rect null', () => {
    expect(
      computeViewportLayout({
        hostRect: { x: 0, y: 0, width: 0, height: 0 },
        preset: 'responsive',
        deviceWidth: 0,
        deviceHeight: 0,
        zoom: 100,
      }),
    ).toEqual({ rect: null, zoomFactor: 1 });
  });

  it('responsive：铺满宿主区域', () => {
    expect(
      computeViewportLayout({
        hostRect: HOST,
        preset: 'responsive',
        deviceWidth: 0,
        deviceHeight: 0,
        zoom: 100,
      }),
    ).toEqual({ rect: HOST, zoomFactor: 1 });
  });

  it('mobile 100%：设备尺寸完整放入（宿主更大）', () => {
    const layout = computeViewportLayout({
      hostRect: HOST,
      preset: 'mobile',
      deviceWidth: 375,
      deviceHeight: 667,
      zoom: 100,
    });
    expect(layout.rect).toEqual({ x: 800, y: 52, width: 375, height: 600 });
    expect(layout.zoomFactor).toBe(1);
  });

  it('desktop 100%：clamp 到宿主区域（1920×1080 → 400×600）', () => {
    const layout = computeViewportLayout({
      hostRect: HOST,
      preset: 'desktop',
      deviceWidth: 1920,
      deviceHeight: 1080,
      zoom: 100,
    });
    expect(layout.rect).toEqual({ x: 800, y: 52, width: 400, height: 600 });
  });

  it('zoom 50%：实际像素 = 设备尺寸 × 0.5（CSS 视口保持设备宽度）', () => {
    const layout = computeViewportLayout({
      hostRect: HOST,
      preset: 'mobile',
      deviceWidth: 375,
      deviceHeight: 667,
      zoom: 50,
    });
    expect(layout.rect).toEqual({ x: 800, y: 52, width: 188, height: 334 });
    expect(layout.zoomFactor).toBe(0.5);
  });

  it('zoom 200%：zoomFactor 2（页面 CSS 视口 = bounds / 2）', () => {
    const layout = computeViewportLayout({
      hostRect: HOST,
      preset: 'responsive',
      deviceWidth: 0,
      deviceHeight: 0,
      zoom: 200,
    });
    expect(layout.rect).toEqual(HOST);
    expect(layout.zoomFactor).toBe(2);
  });
});
