// src/renderer/lib/format-intl.test.ts
// Intl 本地化格式化单测（S6 国际化审计落地）
//
// 测试要点：
// 1. 时钟时间：zh-CN 24 小时制 / en-US 12 小时制（跟随 locale）
// 2. compact 数字：zh 万 / en K·M（本地单位差异）
// 3. 数据契约格式不受影响（ISO 日期保持原样——由调用方保证，本层不处理）

import { describe, expect, it } from 'vitest';

import { formatClockTime, formatCompactNumber, formatDateTime, formatPercent } from './format-intl';

describe('formatClockTime（跟随 locale 小时制）', () => {
  it('zh-CN：24 小时制', () => {
    // 2026-08-27 13:05:09（本地时区）
    const value = new Date(2026, 7, 27, 13, 5, 9);
    expect(formatClockTime(value, 'zh-CN')).toContain('13:05:09');
  });

  it('en-US：12 小时制（PM）', () => {
    const value = new Date(2026, 7, 27, 13, 5, 9);
    const result = formatClockTime(value, 'en-US');
    // en-US 12h 制含 PM 与分钟秒
    expect(result).toMatch(/PM/i);
    expect(result).toContain('05:09');
  });

  it('ISO 字符串入参可用', () => {
    const iso = new Date(2026, 7, 27, 9, 30, 0).toISOString();
    expect(formatClockTime(iso, 'zh-CN')).toContain(':30:');
  });
});

describe('formatCompactNumber（跟随 locale 本地单位）', () => {
  it('zh-CN：万单位（120 万无小数）', () => {
    expect(formatCompactNumber(1_200_000, 'zh-CN')).toContain('120万');
  });

  it('zh-CN：未达万阈值返回原值', () => {
    expect(formatCompactNumber(1500, 'zh-CN')).toBe('1500');
  });

  it('en-US：K 单位', () => {
    expect(formatCompactNumber(1500, 'en-US')).toContain('1.5K');
  });

  it('en-US：M 单位', () => {
    expect(formatCompactNumber(1_200_000, 'en-US')).toContain('1.2M');
  });

  it('小数值原样返回', () => {
    expect(formatCompactNumber(42, 'zh-CN')).toBe('42');
    expect(formatCompactNumber(42, 'en-US')).toBe('42');
  });
});

describe('formatDateTime（跟随 locale 年月日顺序）', () => {
  it('zh-CN：含年月日与时间', () => {
    const value = new Date(2026, 8, 14, 20, 30, 0);
    const result = formatDateTime(value, 'zh-CN');
    expect(result).toContain('2026');
    expect(result).toContain('30'); // 分钟
  });

  it('en-US：月在前（locale 顺序差异）', () => {
    const value = new Date(2026, 8, 14, 20, 30, 0);
    expect(formatDateTime(value, 'en-US')).toMatch(/9\/14\/2026/);
  });

  it('非法时间：返回回退值（缺省空串）', () => {
    expect(formatDateTime('not-a-date', 'zh-CN')).toBe('');
    expect(formatDateTime('not-a-date', 'zh-CN', '原始文本')).toBe('原始文本');
  });
});

describe('formatPercent（入参为百分数，非 0-1 比例）', () => {
  it('整数百分数', () => {
    // 12.5 表示 12.5%（不是 0.125）
    expect(formatPercent(12.5, 'zh-CN', 0)).toContain('13');
    expect(formatPercent(12.5, 'zh-CN', 0)).toContain('%');
  });

  it('指定小数位', () => {
    expect(formatPercent(12.5, 'zh-CN', 1)).toContain('12.5');
  });

  it('0 与 100 边界', () => {
    expect(formatPercent(0, 'zh-CN')).toContain('0');
    expect(formatPercent(100, 'en-US')).toContain('100');
  });
});
