// src/main/infra/telemetry/event-loop-lag.test.ts
// 事件循环延迟监控单测：纯函数 + 采样逻辑 + 生命周期

import { afterEach, describe, expect, it } from 'vitest';
import { EventLoopLagMonitor, measureLag } from './event-loop-lag';

const monitors: EventLoopLagMonitor[] = [];

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
});

describe('measureLag（纯函数）', () => {
  it('正常：无延迟返回 0', () => {
    expect(measureLag(1000, 1000)).toBe(0);
    expect(measureLag(1000, 1100)).toBe(100);
  });

  it('负延迟钳制为 0（时钟异常防御）', () => {
    expect(measureLag(2000, 1500)).toBe(0);
  });
});

describe('EventLoopLagMonitor', () => {
  it('采样：未超阈值不告警，返回样本', () => {
    const monitor = createMonitor({ warnThresholdMs: 1000 });
    const fired: string[] = [];
    monitor.onLag(() => {
      fired.push('lag');
    });
    const sample = monitor.sample();
    expect(sample.exceeded).toBe(false);
    expect(fired).toHaveLength(0);
    expect(sample.lagMs).toBeGreaterThanOrEqual(0);
  });

  it('采样：超阈值触发告警回调（第二次采样起，首次为基准）', async () => {
    const monitor = createMonitor({ warnThresholdMs: 0 });
    const fired: Array<{ lagMs: number }> = [];
    monitor.onLag((sample) => {
      fired.push({ lagMs: sample.lagMs });
    });
    monitor.sample(); // 首次：基准（不告警）
    await new Promise((resolve) => setTimeout(resolve, 5)); // 确保真实时间流逝
    const sample = monitor.sample(); // 第二次：真实延迟 > 0 → 超阈值
    expect(sample.exceeded).toBe(true);
    expect(fired).toHaveLength(1);
  });

  it('onLag：unsubscribe 生效', () => {
    const monitor = createMonitor({ warnThresholdMs: 0 });
    const fired: number[] = [];
    const unsubscribe = monitor.onLag(() => {
      fired.push(1);
    });
    unsubscribe();
    monitor.sample();
    expect(fired).toHaveLength(0);
  });

  it('start/stop：生命周期幂等', () => {
    const monitor = createMonitor({ intervalMs: 10 });
    monitor.start();
    expect(monitor.running).toBe(true);
    monitor.start(); // 幂等
    monitor.stop();
    expect(monitor.running).toBe(false);
    monitor.stop(); // 幂等
  });

  it('构造 onLag 与后续订阅均生效', async () => {
    const fired: number[] = [];
    const monitor = createMonitor({
      warnThresholdMs: 0,
      onLag: () => {
        fired.push(1);
      },
    });
    monitor.sample(); // 基准
    await new Promise((resolve) => setTimeout(resolve, 5));
    monitor.sample();
    expect(fired).toHaveLength(1);
  });
});
