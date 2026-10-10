// zoom.test.ts：界面缩放纯函数单测（档位表 / clampZoom 归一 / stepZoom 步进 / overlayHeightFor 联动）
// 测试名中的 V1/V7/V9 为 docs/design/35-ui-zoom-spec.md §1.3 验收项编号（本套件测试设计见该文 §2.7）

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

  it('V1 缺失语义：非有限数（undefined/NaN/Infinity）→ 默认 1（非最小档）', () => {
    expect(clampZoom(undefined as unknown as number)).toBe(1);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
    // typeof 守卫路径：字符串等非 number 输入回落默认档，与缺失语义同落点
    expect(clampZoom('1.25' as unknown as number)).toBe(1);
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
    // 先归一得 0.9，再放大一档 → 1（不是"非法值直接回落默认档"）
    expect(stepZoom(0.93, 1)).toBe(1);
  });
});

describe('overlayHeightFor', () => {
  it('V7：1 → 52、1.25 → 65、2 → 104（round 联动）', () => {
    expect(overlayHeightFor(1)).toBe(52);
    expect(overlayHeightFor(1.25)).toBe(65);
    expect(overlayHeightFor(2)).toBe(104);
    expect(overlayHeightFor(0.67)).toBe(35); // 52 × 0.67 = 34.84（本组唯一非整数乘积：验证 round 而非截断）
  });
});
