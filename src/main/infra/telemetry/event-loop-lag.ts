// src/main/infra/telemetry/event-loop-lag.ts
// 事件循环延迟监控（P2-36：迁移 perf_hooks.monitorEventLoopDelay 直方图分位）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 周期性从事件循环延迟直方图取分位值（默认 p99），超阈值 → onLag 回调
//   （告警/遥测上报挂载点，见 lag-alert.ts）
// - 返回 stop（生命周期管理；应用退出时清理）
//
// 迁移说明（原 setInterval 期望间隔法 → 直方图分位法，2026-09-27）：
// - 旧实现用「期望 tick 时刻 vs 实际时刻」差值估延迟，只能反映采样定时器
//   自身被延迟的程度，且需要首采基准修正（2026-09-04 修复）；窗口内的短尖刺
//   （如两次准点 tick 之间夹一段 300ms 阻塞）不可见。
// - monitorEventLoopDelay 由 Node 把每次事件循环延迟记入直方图（纳秒），
//   取窗口分位可覆盖全部尖刺；每窗口采样后 reset() 保证 lag 反映「最近窗口」。
// - 对外契约不变：EventLoopLagSample 字段语义与阈值判定（lagMs >
//   warnThresholdMs）保持一致；空窗口分位 ≈ 0，空闲不误报（语义继承）。
// ──────────────────────────────────────────────────────────────

import { monitorEventLoopDelay } from 'node:perf_hooks';

/** 默认采样间隔（毫秒） */
const DEFAULT_INTERVAL_MS = 5_000;

/** 默认告警阈值（毫秒）——超过视为事件循环阻塞 */
const DEFAULT_WARN_THRESHOLD_MS = 1_000;

/** 默认分位数（p99：对持续阻塞与尖刺敏感，偶发毛刺不触发） */
const DEFAULT_PERCENTILE = 99;

/** 纳秒 → 毫秒换算系数 */
const NS_PER_MS = 1e6;

/** 延迟测量结果（lag-alert 消费接口，字段语义不变） */
export interface EventLoopLagSample {
  /** 本窗口事件循环延迟的分位值（毫秒） */
  readonly lagMs: number;
  /** 采样窗口（毫秒） */
  readonly intervalMs: number;
  /** 是否超过告警阈值 */
  readonly exceeded: boolean;
  /** 采样时间 */
  readonly at: number;
}

/** 回调签名 */
export type LagHandler = (sample: EventLoopLagSample) => void;

/**
 * 事件循环延迟直方图最小接口
 *
 * 形状对齐 perf_hooks.IntervalHistogram（纳秒口径）；独立接口供测试注入 fake。
 */
export interface LagHistogram {
  /** 开始记录（幂等；返回是否新启动） */
  enable(): boolean;
  /** 停止记录（幂等） */
  disable(): boolean;
  /** 取分位值（纳秒） */
  percentile(percentile: number): number;
  /** 清空已采集数据（每窗口采样后调用，保证 lag 反映最近窗口） */
  reset(): void;
}

/** 默认直方图工厂：perf_hooks.monitorEventLoopDelay（默认 10ns 分辨率，ms 级阈值精度充足） */
function defaultHistogramFactory(): LagHistogram {
  return monitorEventLoopDelay();
}

/** 监控器配置 */
export interface EventLoopLagMonitorOptions {
  /** 采样间隔（毫秒；默认 5000） */
  readonly intervalMs?: number;
  /** 告警阈值（毫秒；默认 1000） */
  readonly warnThresholdMs?: number;
  /** 分位数（0-100；默认 99） */
  readonly percentile?: number;
  /** 延迟超阈值回调（可多个） */
  readonly onLag?: LagHandler;
  /** 直方图工厂（测试注入 fake；默认 perf_hooks.monitorEventLoopDelay） */
  readonly createHistogram?: () => LagHistogram;
}

/**
 * 事件循环延迟监控器
 */
export class EventLoopLagMonitor {
  private readonly intervalMs: number;
  private readonly warnThresholdMs: number;
  private readonly percentile: number;
  private readonly createHistogram: () => LagHistogram;
  private handlers: LagHandler[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 直方图（构造即创建；enable/disable 随 start/stop） */
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

  /**
   * 订阅延迟告警（可多个订阅者）
   */
  onLag(handler: LagHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /**
   * 启动监控（幂等）
   *
   * 直方图 enable 后由 Node 内部采样事件循环延迟；本监控器按 intervalMs
   * 周期取分位并重置窗口（见 sample）。
   */
  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.histogram.enable();
    const timer = setInterval(() => {
      this.sample();
    }, this.intervalMs);
    // 与 MemoryMonitor 同口径：unref 不阻塞应用退出（窗口关闭驻留托盘时，
    // 该 5s 周期定时器不得阻止 Electron 的退出流程走完）
    timer.unref();
    this.timer = timer;
  }

  /**
   * 停止监控（幂等；应用退出调用）
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      this.histogram.disable();
    }
  }

  /**
   * 采集一次样本（tick 自动调用；可手动触发）
   *
   * lag = 直方图分位（纳秒 → 毫秒）；采样后 reset 直方图，下一窗口重新累计
   * （lag 恒反映「最近一个窗口」而非启动以来累计）。未启动/空窗口分位 ≈ 0，
   * 空闲不误报。
   */
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

  /** 当前是否运行中 */
  get running(): boolean {
    return this.timer !== null;
  }
}
