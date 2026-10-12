import type { BrowserDevicePreset, BrowserZoom } from '@/stores/persistent/settings-store';

/** 设备逻辑尺寸（CSS 像素） */
export interface DeviceDimensions {
  readonly width: number;
  readonly height: number;
}

/** 设备预设清单（顺序即 UI 展示顺序，也是各处下拉/分段控件的顺序来源） */
export const DEVICE_PRESETS: readonly BrowserDevicePreset[] = [
  'responsive',
  'desktop',
  'laptop',
  'tablet',
  'mobile',
];

/**
 * 设备预设 → 逻辑尺寸
 *
 * responsive 用 0 表示「跟随宿主区域」（调用方以 `width > 0` 判定是否需要
 * 覆盖宽高输入框，见 browser-pane 的 handlePresetChange）。
 */
export const DEVICE_DIMENSIONS: Record<BrowserDevicePreset, DeviceDimensions> = {
  responsive: { width: 0, height: 0 },
  desktop: { width: 1920, height: 1080 },
  laptop: { width: 1366, height: 768 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 375, height: 667 },
};

/** 缩放档位（百分比；预览工具栏下拉与设置页分段控件共用） */
export const ZOOM_STEPS: readonly BrowserZoom[] = [50, 75, 100, 125, 150, 200];
