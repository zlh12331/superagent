// src/renderer/components/browser/browser-geometry.ts
// 浏览器预览几何计算（纯函数）：宿主占位区 + 设备预设 + 缩放 → 视图边界
// ──────────────────────────────────────────────────────────────
// WebContentsView 是窗口级原生图层：bounds 不能超出面板占位区，否则会盖住
// 面板之外的其他 UI（DOM z-index 管不住原生层）。固定设备预设按
// 「设备逻辑尺寸 × 缩放」换算实际像素并 clamp 到宿主区域（v1 iframe 的
// overflow 滚动查看溢出部分在原生图层下不可行，超出部分截断显示）。
// zoomFactor 语义：页面 CSS 视口宽度 = bounds.width / zoomFactor。
// ──────────────────────────────────────────────────────────────

import type { BrowserRect } from '@code-agent/shared/renderer';
import type { BrowserDevicePreset } from '@/stores/persistent/settings-store';

/** 宿主占位区矩形（getBoundingClientRect，渲染层视口坐标 = 窗口 contentView 坐标） */
export interface HostRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 视口几何计算输入 */
export interface ViewportLayoutInput {
  /** 占位区矩形（null = 无可视区域，如面板隐藏） */
  hostRect: HostRect | null;
  preset: BrowserDevicePreset;
  /** 设备预设逻辑宽（responsive 时忽略） */
  deviceWidth: number;
  /** 设备预设逻辑高（responsive 时忽略） */
  deviceHeight: number;
  /** 缩放百分比（50–200） */
  zoom: number;
}

/** 视口几何计算输出（rect=null 表示隐藏视图） */
export interface ViewportLayout {
  rect: BrowserRect | null;
  zoomFactor: number;
}

/**
 * 计算原生预览视图的边界与缩放
 *
 * @example
 * ```ts
 * computeViewportLayout({ hostRect: { x: 800, y: 52, width: 400, height: 600 },
 *   preset: 'mobile', deviceWidth: 375, deviceHeight: 667, zoom: 100 });
 * // → { rect: { x: 800, y: 52, width: 375, height: 600 }, zoomFactor: 1 }
 * ```
 */
export function computeViewportLayout(input: ViewportLayoutInput): ViewportLayout {
  const zoomFactor = input.zoom / 100;
  const host = input.hostRect;
  if (host === null || host.width <= 0 || host.height <= 0) {
    return { rect: null, zoomFactor };
  }
  // 响应式：直接铺满宿主区域
  if (input.preset === 'responsive') {
    return {
      rect: { x: host.x, y: host.y, width: host.width, height: host.height },
      zoomFactor,
    };
  }
  // 固定预设：实际像素 = 设备逻辑尺寸 × 缩放，clamp 到宿主区域
  const width = Math.min(Math.round(input.deviceWidth * zoomFactor), host.width);
  const height = Math.min(Math.round(input.deviceHeight * zoomFactor), host.height);
  // 契约守卫：输出必须满足 BrowserRectSchema（宽高 positive）。签名收的是裸
  // number，设备宽高为 0 / 负数（如输入框被清空）时会算出非正宽高——直接下发
  // 会被 IPC 侧 zod 拒绝并静默失败，故此处按「无有效视口」隐藏视图。
  if (width <= 0 || height <= 0) {
    return { rect: null, zoomFactor };
  }
  return {
    rect: { x: host.x, y: host.y, width, height },
    zoomFactor,
  };
}
