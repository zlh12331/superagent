// src/renderer/components/settings/sections/usage-section.test.ts
// usage-section 纯派生函数测试（buildHeatValue / recentDays / toIsoDate）
// 业务逻辑不 mock：直接测真实纯函数实现。

import type { UsageDaySummary } from '@code-agent/shared/renderer';
import { describe, expect, it } from 'vitest';

import { buildHeatValue, recentDays, toIsoDate } from './usage-section';

describe('recentDays', () => {
  it('生成 N 天倒序日期（today 在前，yyyy-MM-dd）', () => {
    const days = recentDays(3);
    expect(days).toHaveLength(3);
    const today = new Date();
    expect(days[0]).toBe(toIsoDate(today));
    // 次日应为今天 +1
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    expect(days[1]).toBe(toIsoDate(yesterday));
  });

  it('格式固定 yyyy-MM-dd（补零）', () => {
    const d = new Date(2026, 0, 5); // 2026-01-05
    expect(toIsoDate(d)).toBe('2026-01-05');
  });
});

describe('toIsoDate', () => {
  it('月/日补零到两位', () => {
    expect(toIsoDate(new Date(2026, 0, 1))).toBe('2026-01-01');
    expect(toIsoDate(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});

describe('buildHeatValue', () => {
  const start = '2026-08-01';
  const end = '2026-08-03';

  it('空数据：生成近 90 天 0 值（ActivityCalendar 不允许 data 为空）', () => {
    const result = buildHeatValue([], start, end);
    expect(result).toHaveLength(90);
    expect(result.every((r) => r.count === 0 && r.level === 0)).toBe(true);
    expect(result[0]?.date).toBe(toIsoDate(new Date()));
  });

  it('undefined 输入同样回退空数据', () => {
    const result = buildHeatValue(undefined, start, end);
    expect(result).toHaveLength(90);
  });

  it('单日数据：仅补首尾空锚点，该日 level=4（唯一值即最大值）', () => {
    const byDay: readonly UsageDaySummary[] = [{ date: end, calls: 1, totalTokens: 100 }];
    const result = buildHeatValue(byDay, start, end);
    expect(result).toHaveLength(2); // start 空锚 + 数据日
    expect(result[0]).toEqual({ date: start, count: 0, level: 0 });
    expect(result[1]).toEqual({ date: end, count: 100, level: 4 });
  });

  it('多日倒序输入：逆转后 level 按最大值分位', () => {
    const byDay: readonly UsageDaySummary[] = [
      { date: '2026-08-03', calls: 1, totalTokens: 400 },
      { date: '2026-08-02', calls: 1, totalTokens: 100 },
    ];
    // 最大值 400：100 → ratio 0.25 → level 1；400 → ratio 1 → level 4
    const result = buildHeatValue(byDay, '2026-08-02', '2026-08-03');
    const item400 = result.find((r) => r.date === '2026-08-03');
    const item100 = result.find((r) => r.date === '2026-08-02');
    expect(item400?.level).toBe(4);
    expect(item100?.level).toBe(1);
  });

  it('全 0 数据：所有格子取最低档 0，且数据日不补锚点', () => {
    const byDay: readonly UsageDaySummary[] = [
      { date: '2026-08-03', calls: 0, totalTokens: 0 },
      { date: '2026-08-02', calls: 0, totalTokens: 0 },
    ];
    const result = buildHeatValue(byDay, '2026-08-02', '2026-08-03');
    expect(result.length).toBe(2);
    expect(result.every((r) => r.level === 0)).toBe(true);
  });
});
