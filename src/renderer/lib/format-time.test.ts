// src/renderer/lib/format-time.test.ts
// formatRelativeTime（相对时间格式化）单测

import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import { formatRelativeTime } from './format-time';

/** 最小 t 桩：justNow 返回固定文案，带 count 的返回 `${key}:${count}`（纯函数测试用，cast 为 TFunction） */
const fakeT = ((key: string, options?: { count?: number }): string => {
  if (key === 'home.justNow') return '刚刚';
  return `${key}:${options?.count ?? 0}`;
}) as unknown as TFunction;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatRelativeTime', () => {
  it('一分钟内：返回「刚刚」', () => {
    expect(formatRelativeTime(Date.now() - 30_000, fakeT)).toBe('刚刚');
  });

  it('分钟级（默认本地化）：返回 home.minutesAgo:count', () => {
    expect(formatRelativeTime(Date.now() - 5 * MINUTE, fakeT)).toBe('home.minutesAgo:5');
  });

  it('小时级（默认本地化）：返回 home.hoursAgo:count', () => {
    expect(formatRelativeTime(Date.now() - 3 * HOUR, fakeT)).toBe('home.hoursAgo:3');
  });

  it('天级（默认本地化）：返回 home.daysAgo:count', () => {
    expect(formatRelativeTime(Date.now() - 2 * DAY, fakeT)).toBe('home.daysAgo:2');
  });

  it('紧凑模式：分钟级返回 Nm', () => {
    expect(formatRelativeTime(Date.now() - 5 * MINUTE, fakeT, true)).toBe('5m');
  });

  it('紧凑模式：小时级返回 Nh', () => {
    expect(formatRelativeTime(Date.now() - 3 * HOUR, fakeT, true)).toBe('3h');
  });

  it('紧凑模式：天级返回 Nd', () => {
    expect(formatRelativeTime(Date.now() - 2 * DAY, fakeT, true)).toBe('2d');
  });

  it('超过一周：返回 YYYY-MM-DD', () => {
    const ts = Date.now() - 10 * DAY;
    const expected = new Date(ts).toISOString().slice(0, 10);
    expect(formatRelativeTime(ts, fakeT)).toBe(expected);
    expect(formatRelativeTime(ts, fakeT, true)).toBe(expected);
  });
});
