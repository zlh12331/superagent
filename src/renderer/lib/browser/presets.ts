// src/renderer/lib/browser/presets.ts
// 浏览器预览设备领域数据（单一真源）
// ──────────────────────────────────────────────────────────────
// 收敛背景：同一份数据此前散在三处且注释互相声称「同源」——
// - 设置页 browser-section：PRESET_STEPS / ZOOM_STEPS
// - 预览工具栏 browser-device-bar：硬编码 5 个 <option> / ZOOM_OPTIONS
// - 预览 pane browser-pane：DEVICE_DIMENSIONS
// 新增一个预设需改三处，任一处漏改即静默漂移（尺寸错会直接算错视口矩形）。
//
// 放在 lib/ 而非 components/browser/：设置域与浏览器预览域都要消费，
// 任一业务域持有都会让另一个业务域反向依赖同级域。
//
// 边界（刻意为之）：本模块只放**无语言属性**的数据（档位清单、逻辑尺寸、
// 缩放数值）。预设与缩放的**文案 key 字面量留在各自 UI 文件**——
// scripts/check-i18n.ts 的「间接引用」规则要求 key 字面量与 `t(变量)`
// 调用同文件，否则会被判为死文案；且该规则正是当初为「常量数组与 t() 同文件」
// 这一既有写法而加。各 UI 用 Record<BrowserDevicePreset, string> 承接，
// 编译期保证穷尽（漏一个预设即类型报错）。
// ──────────────────────────────────────────────────────────────

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
