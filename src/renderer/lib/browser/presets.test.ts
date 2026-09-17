// src/renderer/lib/browser/presets.test.ts
// 浏览器预览领域数据（单一真源）不变量测试
// ──────────────────────────────────────────────────────────────
// 锁的是「数据自身的一致性」，不是渲染结果：
// 消费方（browser-pane / browser-device-bar / settings/browser-section）
// 依赖这里的隐式约定，改动数据时若破坏约定，在此先失败而不是线上静默错。
// （文案 key 的完整性与可解析性由 Record<BrowserDevicePreset, string> 与
//   check:i18n 分别把关，不在本文件重复断言。）
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { DEVICE_DIMENSIONS, DEVICE_PRESETS, ZOOM_STEPS } from './presets';

describe('浏览器预览领域数据', () => {
  it('设备预设：5 档、取值唯一且非空', () => {
    expect(DEVICE_PRESETS).toHaveLength(5);
    expect(new Set(DEVICE_PRESETS).size).toBe(DEVICE_PRESETS.length);
    for (const preset of DEVICE_PRESETS) {
      expect(preset).not.toBe('');
    }
  });

  it('尺寸表：仅 responsive 为零尺寸（「跟随宿主」哨兵），其余预设必为正', () => {
    // handlePresetChange 以 `dims.width > 0` 判定是否覆盖宽高输入框；
    // computeViewportLayout 的契约守卫也依赖「非 responsive 必为正」。
    expect(DEVICE_DIMENSIONS.responsive).toEqual({ width: 0, height: 0 });
    for (const preset of DEVICE_PRESETS) {
      if (preset === 'responsive') continue;
      const dims = DEVICE_DIMENSIONS[preset];
      expect(dims.width).toBeGreaterThan(0);
      expect(dims.height).toBeGreaterThan(0);
    }
  });

  it('缩放档位：升序排列，且换算后在 browser:setViewport 契约区间 [0.25, 4] 内', () => {
    expect(ZOOM_STEPS.length).toBeGreaterThan(0);
    expect([...ZOOM_STEPS]).toEqual([...ZOOM_STEPS].sort((a, b) => a - b));
    for (const zoom of ZOOM_STEPS) {
      const zoomFactor = zoom / 100;
      expect(zoomFactor).toBeGreaterThanOrEqual(0.25);
      expect(zoomFactor).toBeLessThanOrEqual(4);
    }
  });
});
