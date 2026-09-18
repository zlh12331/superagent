// src/renderer/lib/format-bytes.test.ts
// 字节 / 时长格式化单测（纯函数：边界值 / 进位 / 缺省占位）
import { describe, expect, it } from 'vitest';

import { formatBytes, formatClock, formatRemainingClock } from './format-bytes';

describe('formatBytes', () => {
  it('非正数与非有限数 → 0 B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });

  it('字节级取整不带小数', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('按 1024 进位并保留一位小数', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(12_345_678)).toBe('11.8 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
  });

  it('超出 TB 时停在 TB（不再进位）', () => {
    expect(formatBytes(1024 ** 5)).toBe('1024.0 TB');
  });
});

describe('formatClock', () => {
  it('非正数与非有限数 → 0:00', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(-5)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });

  it('分钟以内补零到两位秒', () => {
    expect(formatClock(18)).toBe('0:18');
    expect(formatClock(59.4)).toBe('0:59');
  });

  it('跨分钟与跨小时', () => {
    expect(formatClock(95)).toBe('1:35');
    expect(formatClock(3_725)).toBe('1:02:05');
  });
});

describe('formatRemainingClock', () => {
  it('按速率估算剩余时长', () => {
    expect(formatRemainingClock(0, 1024, 512)).toBe('0:02');
  });

  it('速率无效或已下完 → null（调用方用占位符）', () => {
    expect(formatRemainingClock(10, 100, 0)).toBeNull();
    expect(formatRemainingClock(100, 100, 10)).toBeNull();
    expect(formatRemainingClock(0, 100, Number.NaN)).toBeNull();
  });
});
