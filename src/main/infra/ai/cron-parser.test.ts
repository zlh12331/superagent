// src/main/infra/ai/cron-parser.test.ts
// cron 解析器单测：字段语法/匹配/下次触发

import { describe, expect, it } from 'vitest';
import { matches, nextFireTime, parseCron } from './cron-parser';

describe('parseCron', () => {
  it('基础：每分钟（* * * * *）', () => {
    const s = parseCron('* * * * *');
    expect(s.minute.has(0)).toBe(true);
    expect(s.minute.has(59)).toBe(true);
    expect(s.domIsWild).toBe(true);
    expect(s.dowIsWild).toBe(true);
  });

  it('单值 + 列表：每小时的 5 分和 10 分', () => {
    const s = parseCron('5,10 * * * *');
    expect(s.minute.has(5)).toBe(true);
    expect(s.minute.has(10)).toBe(true);
    expect(s.minute.has(11)).toBe(false);
  });

  it('步进：每 15 分钟（*/15）', () => {
    const s = parseCron('*/15 * * * *');
    expect(s.minute.has(0)).toBe(true);
    expect(s.minute.has(15)).toBe(true);
    expect(s.minute.has(30)).toBe(true);
    expect(s.minute.has(45)).toBe(true);
    expect(s.minute.has(10)).toBe(false);
  });

  it('范围：9-18 点', () => {
    const s = parseCron('0 9-18 * * *');
    expect(s.hour.has(9)).toBe(true);
    expect(s.hour.has(18)).toBe(true);
    expect(s.hour.has(19)).toBe(false);
  });

  it('周字段：0 和 7 均表示周日', () => {
    const s = parseCron('0 0 * * 7');
    expect(s.dayOfWeek.has(0)).toBe(true);
    expect(s.dayOfWeek.has(7)).toBe(false); // 归一为 0
  });

  it('字段数不足：抛错', () => {
    expect(() => parseCron('* * * *')).toThrow('5 个字段');
  });

  it('取值越界：抛错', () => {
    expect(() => parseCron('60 * * * *')).toThrow('越界');
    expect(() => parseCron('* 24 * * *')).toThrow('越界');
  });

  it('非法语法：抛错', () => {
    expect(() => parseCron('a * * * *')).toThrow('无效');
    expect(() => parseCron('*/0 * * * *')).toThrow('步长');
  });
});

describe('matches', () => {
  it('每分钟匹配任意时间', () => {
    const s = parseCron('* * * * *');
    expect(matches(s, new Date(2026, 7, 4, 10, 30))).toBe(true);
  });

  it('特定分钟：仅匹配对应分钟', () => {
    const s = parseCron('30 * * * *');
    expect(matches(s, new Date(2026, 7, 4, 10, 30))).toBe(true);
    expect(matches(s, new Date(2026, 7, 4, 10, 31))).toBe(false);
  });

  it('工作日 9 点（0 9 * * 1-5）', () => {
    const s = parseCron('0 9 * * 1-5');
    // 2026-08-03 是周一
    expect(matches(s, new Date(2026, 7, 3, 9, 0))).toBe(true);
    // 2026-08-02 是周日
    expect(matches(s, new Date(2026, 7, 2, 9, 0))).toBe(false);
    // 周六 2026-08-01
    expect(matches(s, new Date(2026, 7, 1, 9, 0))).toBe(false);
  });

  it('特定日期（0 0 15 * *）：每月 15 号', () => {
    const s = parseCron('0 0 15 * *');
    expect(matches(s, new Date(2026, 7, 15, 0, 0))).toBe(true);
    expect(matches(s, new Date(2026, 7, 14, 0, 0))).toBe(false);
  });
});

describe('nextFireTime', () => {
  it('每分钟：返回下一分钟', () => {
    const s = parseCron('* * * * *');
    const from = new Date(2026, 7, 4, 10, 30, 45);
    const next = nextFireTime(s, from);
    expect(next.getMinutes()).toBe(31);
    expect(next.getSeconds()).toBe(0);
  });

  it('特定分钟：返回下一个匹配分钟', () => {
    const s = parseCron('5 * * * *');
    const next = nextFireTime(s, new Date(2026, 7, 4, 10, 6));
    expect(next.getHours()).toBe(11);
    expect(next.getMinutes()).toBe(5);
  });

  it('每天 9 点：跨天正确', () => {
    const s = parseCron('0 9 * * *');
    const next = nextFireTime(s, new Date(2026, 7, 4, 10, 0));
    expect(next.getDate()).toBe(5);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });
});
