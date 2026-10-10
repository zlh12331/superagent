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
  if (input.preset === 'responsive') {
    return {
      rect: { x: host.x, y: host.y, width: host.width, height: host.height },
      zoomFactor,
    };
  }
  const width = Math.min(Math.round(input.deviceWidth * zoomFactor), host.width);
  const height = Math.min(Math.round(input.deviceHeight * zoomFactor), host.height);
  if (width <= 0 || height <= 0) {
    return { rect: null, zoomFactor };
  }
  return {
    rect: { x: host.x, y: host.y, width, height },
    zoomFactor,
  };
}
