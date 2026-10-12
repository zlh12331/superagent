import { afterEach, describe, expect, it, vi } from 'vitest';

import { EventLoopLagMonitor, type LagHistogram } from './event-loop-lag';

const monitors: EventLoopLagMonitor[] = [];

function createFakeHistogram(initialNs = 0) {
  const calls = { enable: 0, disable: 0, reset: 0 };
  let valueNs = initialNs;
  const histogram: LagHistogram = {
    enable: vi.fn(() => {
      calls.enable += 1;
      return true;
    }),
    disable: vi.fn(() => {
      calls.disable += 1;
      return true;
    }),
    percentile: vi.fn(() => valueNs),
    reset: vi.fn(() => {
      calls.reset += 1;
      valueNs = 0;
    }),
  };
  return {
    histogram,
    calls,
    setNs: (v: number) => {
      valueNs = v;
    },
  };
}

function createMonitor(options?: ConstructorParameters<typeof EventLoopLagMonitor>[0]) {
  const monitor = new EventLoopLagMonitor(options);
  monitors.push(monitor);
  return monitor;
}

afterEach(() => {
  for (const monitor of monitors) {
    monitor.stop();
  }
  monitors.length = 0;
  vi.useRealTimers();
});

describe('EventLoopLagMonitor（直方图分位语义）', () => {
  it('分位值换算：纳秒 → 毫秒，超阈值触发 onLag', () => {
    const fake = createFakeHistogram();
    const fired: Array<{ lagMs: number }> = [];
    const monitor = createMonitor({
      warnThresholdMs: 1000,
      createHistogram: () => fake.histogram,
      onLag: (sample) => fired.push({ lagMs: sample.lagMs }),
    });
    fake.setNs(1.5e9);
    const sample = monitor.sample(1000);
    expect(sample.lagMs).toBeCloseTo(1500, 6);
    expect(sample.exceeded).toBe(true);
    expect(sample.intervalMs).toBe(5000);
    expect(fired).toEqual([{ lagMs: sample.lagMs }]);
  });

  it('阈值边界语义与旧实现一致：lagMs == 阈值不告警（严格大于）', () => {
    const fake = createFakeHistogram(1e9);
    const fired: number[] = [];
    const monitor = createMonitor({
      warnThresholdMs: 1000,
      createHistogram: () => fake.histogram,
      onLag: () => fired.push(1),
    });
    const sample = monitor.sample(1000);
    expect(sample.lagMs).toBeCloseTo(1000, 6);
    expect(sample.exceeded).toBe(false);
    expect(fired).toHaveLength(0);
  });

  it('采样后 reset 直方图（lag 恒反映最近窗口；未 start 采样不告警）', () => {
    const fake = createFakeHistogram();
    const monitor = createMonitor({ createHistogram: () => fake.histogram });
    fake.setNs(100e6);
    monitor.sample();
    expect(fake.calls.reset).toBe(1);
    const second = monitor.sample();
    expect(second.lagMs).toBe(0);
    expect(second.exceeded).toBe(false);
  });

  it('onLag：unsubscribe 生效', () => {
    const fake = createFakeHistogram(2e9);
    const fired: number[] = [];
    const monitor = createMonitor({ createHistogram: () => fake.histogram });
    const unsubscribe = monitor.onLag(() => fired.push(1));
    unsubscribe();
    monitor.sample();
    expect(fired).toHaveLength(0);
  });

  it('构造 onLag 与后续订阅均生效', () => {
    const fake = createFakeHistogram(2e9);
    const fired: number[] = [];
    const monitor = createMonitor({
      createHistogram: () => fake.histogram,
      onLag: () => fired.push(1),
    });
    monitor.onLag(() => fired.push(2));
    monitor.sample();
    expect(fired).toEqual([1, 2]);
  });

  it('start/stop：histogram enable/disable 联动 + 生命周期幂等', () => {
    const fake = createFakeHistogram();
    const monitor = createMonitor({ intervalMs: 10, createHistogram: () => fake.histogram });
    monitor.start();
    expect(monitor.running).toBe(true);
    expect(fake.calls.enable).toBe(1);
    monitor.start();
    expect(fake.calls.enable).toBe(1);
    monitor.stop();
    expect(monitor.running).toBe(false);
    expect(fake.calls.disable).toBe(1);
    monitor.stop();
    expect(fake.calls.disable).toBe(1);
  });

  it('start 后按 intervalMs 周期采样（tick 自动取分位 + reset）', () => {
    vi.useFakeTimers();
    const fake = createFakeHistogram();
    const monitor = createMonitor({ intervalMs: 1000, createHistogram: () => fake.histogram });
    monitor.start();
    vi.advanceTimersByTime(1000);
    expect(fake.histogram.percentile).toHaveBeenCalledTimes(1);
    expect(fake.calls.reset).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(fake.histogram.percentile).toHaveBeenCalledTimes(2);
  });

  it('回归（语义继承）：start() 空闲环境连续 tick 不误报', () => {
    vi.useFakeTimers();
    const monitor = createMonitor({ intervalMs: 1000, warnThresholdMs: 100 });
    const fired: number[] = [];
    monitor.onLag(() => fired.push(1));
    monitor.start();
    vi.advanceTimersByTime(5000);
    expect(fired).toHaveLength(0);
  });
});
