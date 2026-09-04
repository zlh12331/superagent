// src/main/infra/telemetry/event-loop-lag.test.ts
// 事件循环延迟监控单测：纯函数 + 采样逻辑（含 start() 空闲不误报回归）+ 生命周期
// ──────────────────────────────────────────────────────────────
// 2026-09-04 修复背景：旧实现把"采样间隔本身"误判为延迟（start() 后恒报
// lag≈interval），空闲环境 5s/条误告警并污染 Sentry。修复后 lag 只反映
// "实际采样间隔超出期望间隔"的部分；本文件同步对齐该语义并补回归用例。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  vi.useRealTimers();
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

describe('EventLoopLagMonitor（采样语义：lag = 实际间隔 − 期望间隔）', () => {
  beforeEach(() => {
    // 集中配置默认：告警阈值 1000ms，期望间隔 5000ms（与生产一致）
  });

  it('首采为基准：不告警，且只记录期望时刻', () => {
    const monitor = createMonitor({ warnThresholdMs: 1000 });
    const fired: string[] = [];
    monitor.onLag(() => {
      fired.push('lag');
    });
    const sample = monitor.sample(1000);
    expect(sample.lagMs).toBe(0);
    expect(sample.exceeded).toBe(false);
    expect(fired).toHaveLength(0);
  });

  it('间隔 = 期望间隔：正常采样不告警（修复前误报场景）', () => {
    const monitor = createMonitor({ warnThresholdMs: 1000 });
    const fired: string[] = [];
    monitor.onLag(() => {
      fired.push('lag');
    });
    monitor.sample(1000); // 基准 → 期望下个采样时刻 1000 + 5000 = 6000
    const sample = monitor.sample(6000); // 准点到达：lag = 0
    expect(sample.lagMs).toBe(0);
    expect(sample.exceeded).toBe(false);
    expect(fired).toHaveLength(0);
  });

  it('超出期望间隔：真实阻塞才告警（阈值 1000，滞后 2000 触发）', () => {
    const monitor = createMonitor({ warnThresholdMs: 1000 });
    const fired: Array<{ lagMs: number }> = [];
    monitor.onLag((sample) => {
      fired.push({ lagMs: sample.lagMs });
    });
    monitor.sample(1000); // 期望下个采样时刻 6000
    // 事件循环被阻塞：本应 6000 采样，实际 8000 才采到 → lag = 8000 - 6000 = 2000
    const sample = monitor.sample(8000);
    expect(sample.lagMs).toBe(2000);
    expect(sample.exceeded).toBe(true);
    expect(fired).toEqual([{ lagMs: 2000 }]);
  });

  it('滞后恢复后：下一轮期望随实测推进，空闲不再持续误报', () => {
    const monitor = createMonitor({ warnThresholdMs: 1000 });
    const fired: Array<{ lagMs: number }> = [];
    monitor.onLag((sample) => {
      fired.push({ lagMs: sample.lagMs });
    });
    monitor.sample(1000); // 期望 6000
    monitor.sample(9000); // 阻塞 3000 → lag 3000，期望推进为 9000 + 5000 = 14000
    const recovered = monitor.sample(14000); // 恢复准点
    expect(recovered.lagMs).toBe(0);
    expect(recovered.exceeded).toBe(false);
    expect(fired).toEqual([{ lagMs: 3000 }]); // 仅阻塞轮告警
  });

  it('onLag：unsubscribe 生效', () => {
    const monitor = createMonitor({ warnThresholdMs: 1000 });
    const fired: number[] = [];
    const unsubscribe = monitor.onLag(() => {
      fired.push(1);
    });
    unsubscribe();
    monitor.sample(1000);
    monitor.sample(9000); // 若未退订此时应告警
    expect(fired).toHaveLength(0);
  });

  it('构造 onLag 与后续订阅均生效', () => {
    const fired: number[] = [];
    const monitor = createMonitor({
      warnThresholdMs: 1000,
      onLag: () => {
        fired.push(1);
      },
    });
    monitor.sample(1000);
    monitor.sample(9000);
    expect(fired).toHaveLength(1);
  });

  it('回归：start() 空闲环境连续 tick 不误报（修复核心）', () => {
    vi.useFakeTimers();
    const monitor = createMonitor({ intervalMs: 1000, warnThresholdMs: 100 });
    const fired: number[] = [];
    monitor.onLag(() => {
      fired.push(1);
    });
    monitor.start();
    // 空闲推进 5 个期望周期：定时器准点触发，lag 应为 0，不得告警
    vi.advanceTimersByTime(5000);
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
});
