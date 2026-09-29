// packages/shared/src/constants/zoom.test.ts
// 界面缩放纯函数单测（35 号 §2.7；V1 归一半 / V9 边界钳制 / V7 overlay 数值）
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { clampZoom, DEFAULT_ZOOM, overlayHeightFor, stepZoom, ZOOM_LEVELS } from './zoom';

describe('ZOOM_LEVELS', () => {
  it('11 档升序且含默认 1（Chrome 缩放谱系）', () => {
    expect(ZOOM_LEVELS).toHaveLength(11);
    expect([...ZOOM_LEVELS]).toEqual([...ZOOM_LEVELS].sort((a, b) => a - b));
    expect(ZOOM_LEVELS).toContain(DEFAULT_ZOOM);
  });
});

describe('clampZoom', () => {
  it('合法档位原样返回', () => {
    for (const level of ZOOM_LEVELS) {
      expect(clampZoom(level)).toBe(level);
    }
  });

  it('V1 损坏语义：任意数值归一到最近档位（0.93 → 0.9）', () => {
    expect(clampZoom(0.93)).toBe(0.9);
    expect(clampZoom(1.08)).toBe(1.1);
    expect(clampZoom(1.2)).toBe(1.25);
  });

  it('越界值钳到端点（负数/超大值）', () => {
    expect(clampZoom(-3)).toBe(0.5);
    expect(clampZoom(99)).toBe(2);
  });
});

describe('stepZoom', () => {
  it('V9 放大/缩小按档位移动', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(0.9, 1)).toBe(1);
  });

  it('V9 边界钳制：两端不回绕', () => {
    expect(stepZoom(2, 1)).toBe(2);
    expect(stepZoom(0.5, -1)).toBe(0.5);
  });

  it('current 非法时先归一再步进', () => {
    expect(stepZoom(0.93, 1)).toBe(1);
  });
});

describe('overlayHeightFor', () => {
  it('V7：1 → 52、1.25 → 65、2 → 104（round 联动）', () => {
    expect(overlayHeightFor(1)).toBe(52);
    expect(overlayHeightFor(1.25)).toBe(65);
    expect(overlayHeightFor(2)).toBe(104);
    expect(overlayHeightFor(0.67)).toBe(35); // 34.84 → 35
  });
});
