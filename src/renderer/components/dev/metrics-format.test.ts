// src/renderer/components/$1/metrics-format.test.ts
// 运行时指标格式化单测（正向 / 边界）
// ──────────────────────────────────────────────────────────────
// 三个函数的档位阈值是显式约定，用边界值锁住：
// 每档的「起始值」与「上一档最大值」都要断言，避免再次出现
// 「1 KB 显示成 0.0 MB」这类档位塌陷。
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { formatBytes, formatMs, formatUptime } from './metrics-format';

describe('formatBytes', () => {
  it('小于 1 KB：按字节原样输出', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('KB 档（1 KB 起）：一位小数', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('MB 档（1 MB 起）：一位小数', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(100 * 1024 * 1024)).toBe('100.0 MB');
  });

  it('GB 档（1 GB 起）：两位小数', () => {
    expect(formatBytes(1024 ** 3)).toBe('1.00 GB');
    expect(formatBytes(1536 * 1024 * 1024)).toBe('1.50 GB');
  });

  it('MB 档上边界：1 MB - 1 B 仍属 KB 档（一位小数取整显示为 1024.0 KB）', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1024.0 KB');
  });
});

describe('formatMs', () => {
  it('毫秒档（< 1 s）：取整到毫秒', () => {
    expect(formatMs(0)).toBe('0 ms');
    expect(formatMs(1_500)).toBe('2 ms');
    expect(formatMs(500_000)).toBe('500 ms');
  });

  it('秒档（1 s 起）：两位小数', () => {
    expect(formatMs(1_000_000)).toBe('1.00 s');
    expect(formatMs(1_500_000)).toBe('1.50 s');
  });

  it('秒档下边界：999999 µs 取整为 1000 ms（一位小数取整产物，再高即切秒档）', () => {
    expect(formatMs(999_999)).toBe('1000 ms');
  });
});

describe('formatUptime', () => {
  it('秒档：不足 1 分钟', () => {
    expect(formatUptime(0)).toBe('0s');
    expect(formatUptime(45)).toBe('45s');
  });

  it('分档：不足 1 小时（含整分边界）', () => {
    expect(formatUptime(60)).toBe('1m 0s');
    expect(formatUptime(3599)).toBe('59m 59s');
  });

  it('时档：1 小时起（含整点边界）', () => {
    expect(formatUptime(3600)).toBe('1h 0m 0s');
    expect(formatUptime(3661)).toBe('1h 1m 1s');
  });

  it('超过一天不折算为天', () => {
    expect(formatUptime(90_061)).toBe('25h 1m 1s');
  });

  it('小数秒：向下取整', () => {
    expect(formatUptime(90.7)).toBe('1m 30s');
  });
});
