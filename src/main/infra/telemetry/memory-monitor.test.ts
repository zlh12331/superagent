// src/main/infra/telemetry/memory-monitor.test.ts
// memory-monitor 单测：泄漏嫌疑检测纯函数 + 监控器生命周期行为
// ──────────────────────────────────────────────────────────────
// 测试维度（职责分离）：
// - detectGrowth 纯函数：单调增长命中 / GC 抖动不命中 / 阈值 / 数据不足（告警判定全部在此）
// - MemoryMonitor：start/stop 幂等、running 状态、onAlert 挂载/退订（定时器生命周期）
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { detectGrowth, MemoryMonitor, type MemorySample } from './memory-monitor';

/** 构造采样序列（rss 按传入值，时间按 60s 递增） */
function series(rssList: readonly number[], startAt = 1_700_000_000_000): MemorySample[] {
  return rssList.map((rssMb, i) => ({
    rssMb,
    heapUsedMb: rssMb * 0.5,
    externalMb: 10,
    at: startAt + i * 60_000,
  }));
}

describe('detectGrowth（泄漏嫌疑检测纯函数）', () => {
  it('连续单调增长且累计超阈值 → 命中并返回窗口报告', () => {
    const samples = series([500, 560, 700, 900]); // 3 次连续增长，累计 400MB > 150MB
    const report = detectGrowth(samples);
    expect(report).not.toBeNull();
    expect(report?.growthMb).toBeCloseTo(400);
    expect(report?.durationSec).toBe(180);
  });

  it('单次增长后回落（GC 抖动）→ 不命中', () => {
    // 500 → 900 → 520：只有 1 次连续增长，不满足 3 次
    const samples = series([500, 900, 520, 530]);
    expect(detectGrowth(samples)).toBeNull();
  });

  it('累计增长不足阈值 → 不命中', () => {
    // 连续 3 次增长但累计仅 20MB < 150MB
    const samples = series([500, 510, 515, 520]);
    expect(detectGrowth(samples)).toBeNull();
  });

  it('数据不足（少于 consecutive+1 条）→ 不命中', () => {
    const samples = series([500, 700]); // 仅 2 条
    expect(detectGrowth(samples)).toBeNull();
  });

  it('空序列 → 不命中', () => {
    expect(detectGrowth([])).toBeNull();
  });

  it('自定义阈值生效（consecutive/growthMb 参数）', () => {
    // 默认阈值 150MB 不命中；自定义 5MB 命中
    const samples = series([500, 510, 515, 520]);
    expect(detectGrowth(samples, 3, 5)).not.toBeNull();
  });
});

describe('MemoryMonitor（生命周期行为）', () => {
  it('start 幂等（重复调用不重复建定时器）', () => {
    const monitor = new MemoryMonitor();
    monitor.start();
    const timer = (monitor as unknown as { timer: ReturnType<typeof setInterval> | null }).timer;
    monitor.start();
    expect((monitor as unknown as { timer: ReturnType<typeof setInterval> | null }).timer).toBe(
      timer,
    ); // 同一定时器实例
    expect(monitor.running).toBe(true);
    monitor.stop();
  });

  it('stop 幂等且清理定时器', () => {
    const monitor = new MemoryMonitor();
    monitor.start();
    monitor.stop();
    monitor.stop();
    expect(monitor.running).toBe(false);
    expect((monitor as unknown as { timer: unknown }).timer).toBeNull();
  });

  it('onAlert 订阅/退订（退订后不再收到回调）', () => {
    const monitor = new MemoryMonitor();
    const calls: string[] = [];
    const unsubscribe = monitor.onAlert(() => calls.push('alert'));
    // 手动触发 handler 验证订阅链路（告警判定由纯函数覆盖，此处测挂载/退订）
    // 通过内部 handlers 数组直接验证注册/移除
    expect((monitor as unknown as { handlers: unknown[] }).handlers.length).toBe(1);
    unsubscribe();
    expect((monitor as unknown as { handlers: unknown[] }).handlers.length).toBe(0);
    expect(calls).toEqual([]);
  });

  it('sample 返回真实内存快照（字段齐全）', () => {
    const monitor = new MemoryMonitor();
    const sample = monitor.sample();
    expect(sample.rssMb).toBeGreaterThan(0);
    expect(sample.heapUsedMb).toBeGreaterThan(0);
    expect(sample.externalMb).toBeGreaterThanOrEqual(0);
    expect(sample.at).toBeGreaterThan(0);
  });
});
