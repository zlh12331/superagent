// event-loop-lag.ts：主进程事件循环延迟监控——monitorEventLoopDelay 直方图按间隔采样 p99
// 基准按期望间隔推进，空闲不误报（有活跃回合才值得告警，判定在 lag-alert 侧）
import { monitorEventLoopDelay } from 'node:perf_hooks';

// 采样 5s 一档；p99 超 1s 判为「阻塞」；1e6 纳秒/毫秒换算
const DEFAULT_INTERVAL_MS = 5_000;

const DEFAULT_WARN_THRESHOLD_MS = 1_000;

const DEFAULT_PERCENTILE = 99;

const NS_PER_MS = 1e6;

export interface EventLoopLagSample {
  readonly lagMs: number;
  readonly intervalMs: number;
  readonly exceeded: boolean;
  readonly at: number;
}

export type LagHandler = (sample: EventLoopLagSample) => void;

/** 直方图最小接口（createHistogram 注入缝：测试用 fake 替换 monitorEventLoopDelay） */
export interface LagHistogram {
  enable(): boolean;
  disable(): boolean;
  percentile(percentile: number): number;
  reset(): void;
}

function defaultHistogramFactory(): LagHistogram {
  return monitorEventLoopDelay();
}

export interface EventLoopLagMonitorOptions {
  readonly intervalMs?: number;
  readonly warnThresholdMs?: number;
  readonly percentile?: number;
  readonly onLag?: LagHandler;
  readonly createHistogram?: () => LagHistogram;
}

/**
 * 事件循环延迟监控器：enable 直方图 → 定时取 p99 并 reset → 超阈值回调全部 handler
 *
 * timer unref：监控不阻止进程退出
 */
export class EventLoopLagMonitor {
  private readonly intervalMs: number;
  private readonly warnThresholdMs: number;
  private readonly percentile: number;
  private readonly createHistogram: () => LagHistogram;
  private handlers: LagHandler[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly histogram: LagHistogram;

  constructor(options: EventLoopLagMonitorOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.warnThresholdMs = options.warnThresholdMs ?? DEFAULT_WARN_THRESHOLD_MS;
    this.percentile = options.percentile ?? DEFAULT_PERCENTILE;
    this.createHistogram = options.createHistogram ?? defaultHistogramFactory;
    this.histogram = this.createHistogram();
    if (options.onLag !== undefined) {
      this.handlers.push(options.onLag);
    }
  }

  onLag(handler: LagHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.histogram.enable();
    const timer = setInterval(() => {
      this.sample();
    }, this.intervalMs);
    timer.unref();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      this.histogram.disable();
    }
  }

  sample(now = Date.now()): EventLoopLagSample {
    const lagMs = this.histogram.percentile(this.percentile) / NS_PER_MS;
    this.histogram.reset();
    const sample: EventLoopLagSample = {
      lagMs,
      intervalMs: this.intervalMs,
      exceeded: lagMs > this.warnThresholdMs,
      at: now,
    };
    if (sample.exceeded) {
      for (const handler of this.handlers) {
        handler(sample);
      }
    }
    return sample;
  }

  get running(): boolean {
    return this.timer !== null;
  }
}
