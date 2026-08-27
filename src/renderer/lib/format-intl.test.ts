// src/renderer/lib/format-intl.test.ts
// Intl 本地化格式化单测（S6 国际化审计落地）
//
// 测试要点：
// 1. 时钟时间：zh-CN 24 小时制 / en-US 12 小时制（跟随 locale）
// 2. compact 数字：zh 万 / en K·M（本地单位差异）
// 3. 数据契约格式不受影响（ISO 日期保持原样——由调用方保证，本层不处理）

import { describe, expect, it } from 'vitest';

import { formatClockTime, formatCompactNumber } from './format-intl';

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
