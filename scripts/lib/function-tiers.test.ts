// scripts/lib/function-tiers.test.ts
// 函数体净行分档单测（2026-09-08 用户拍板 100/200/400）
import { describe, expect, it } from 'vitest';
import { type BodyTiers, countTiers, tierOf, validateHeavyExempt } from './function-tiers';

const LIMIT = 40;
const TIERS: BodyTiers = { mild: 100, moderate: 200, heavy: 400 };

describe('tierOf（体长分档）', () => {
  it('未超规范门槛 → null（不入档）', () => {
    expect(tierOf(40, LIMIT, TIERS)).toBeNull();
    expect(tierOf(1, LIMIT, TIERS)).toBeNull();
  });

  it('边界值归入较小档（含上界）', () => {
    expect(tierOf(41, LIMIT, TIERS)).toBe('mild');
    expect(tierOf(100, LIMIT, TIERS)).toBe('mild');
    expect(tierOf(101, LIMIT, TIERS)).toBe('moderate');
    expect(tierOf(200, LIMIT, TIERS)).toBe('moderate');
    expect(tierOf(201, LIMIT, TIERS)).toBe('heavy');
    expect(tierOf(400, LIMIT, TIERS)).toBe('heavy');
    expect(tierOf(401, LIMIT, TIERS)).toBe('over');
  });

  it('阈值来自参数（不硬编码）', () => {
    const custom: BodyTiers = { mild: 50, moderate: 60, heavy: 70 };
    expect(tierOf(55, LIMIT, custom)).toBe('moderate');
    expect(tierOf(75, LIMIT, custom)).toBe('over');
  });
});

describe('countTiers（各档统计）', () => {
  it('按档累加，未超门槛不计', () => {
    // 10/40 未超门槛（≤40）不入档；41/100 → mild；150 → moderate；300 → heavy；500 → over
    const counts = countTiers([10, 40, 41, 100, 150, 300, 500], LIMIT, TIERS);
    expect(counts).toEqual({ mild: 2, moderate: 1, heavy: 1, over: 1 });
  });

  it('空输入全 0', () => {
    expect(countTiers([], LIMIT, TIERS)).toEqual({ mild: 0, moderate: 0, heavy: 0, over: 0 });
  });
});

describe('validateHeavyExempt（>400 档登记校验）', () => {
  const over = [
    { key: 'a.ts#f', bodyLines: 500 },
    { key: 'b.ts#g', bodyLines: 450 },
  ];

  it('未登记的 >400 条目被报出', () => {
    const r = validateHeavyExempt(over, new Set(['a.ts#f']));
    expect(r.unregistered.map((e) => e.key)).toEqual(['b.ts#g']);
    expect(r.stale).toEqual([]);
  });

  it('登记表中已不再 >400 的条目被判 stale', () => {
    const r = validateHeavyExempt(over, new Set(['a.ts#f', 'b.ts#g', 'gone.ts#h']));
    expect(r.unregistered).toEqual([]);
    expect(r.stale).toEqual(['gone.ts#h']);
  });

  it('空登记表 → 全部未登记', () => {
    const r = validateHeavyExempt(over, new Set());
    expect(r.unregistered).toHaveLength(2);
    expect(r.stale).toEqual([]);
  });
});
