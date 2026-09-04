// src/main/infra/telemetry/event-loop-lag.ts
// 事件循环延迟监控（对齐 qwen telemetry event-loop-lag 语义收敛）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 周期性测量事件循环延迟（期望 tick 间隔 vs 实际间隔）
// - 超过阈值 → onLag 回调（告警/遥测上报挂载点）
// - 返回 stop（生命周期管理；应用退出时清理）
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/core/src/telemetry/event-loop-lag.ts
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// 延迟测量语义，按我们的技术栈收敛重写（移除遥测 exporter 强耦合，回调挂载点）。
// ──────────────────────────────────────────────────────────────

/** 默认采样间隔（毫秒） */
const DEFAULT_INTERVAL_MS = 5_000;

/** 默认告警阈值（毫秒）——超过视为事件循环阻塞 */
const DEFAULT_WARN_THRESHOLD_MS = 1_000;

/** 延迟测量结果 */
export interface EventLoopLagSample {
  /** 本次实测延迟（毫秒） */
  readonly lagMs: number;
  /** 期望间隔（毫秒） */
  readonly intervalMs: number;
  /** 是否超过告警阈值 */
  readonly exceeded: boolean;
  /** 采样时间 */
  readonly at: number;
}

/** 回调签名 */
export type LagHandler = (sample: EventLoopLagSample) => void;

/** 监控器配置 */
export interface EventLoopLagMonitorOptions {
  /** 采样间隔（毫秒；默认 5000） */
  readonly intervalMs?: number;
  /** 告警阈值（毫秒；默认 1000） */
  readonly warnThresholdMs?: number;
  /** 延迟超阈值回调（可多个） */
  readonly onLag?: LagHandler;
}

/** 延迟计算纯函数（可测）：期望时刻 → 当前时刻 的差值 */
export function measureLag(expectedAt: number, now: number): number {
  return Math.max(0, now - expectedAt);
}

/**
 * 事件循环延迟监控器
 */
export class EventLoopLagMonitor {
  private readonly intervalMs: number;
  private readonly warnThresholdMs: number;
  private handlers: LagHandler[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 上一次 tick 的期望时刻（用于计算实际延迟） */
  private lastExpectedAt = 0;

  constructor(options: EventLoopLagMonitorOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.warnThresholdMs = options.warnThresholdMs ?? DEFAULT_WARN_THRESHOLD_MS;
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
   * 基准语义：lastExpectedAt 存"下一个 tick 的期望时刻"。
   * 首个 tick 期望在 `启动时刻 + interval`，故起始基准提前一个 interval——
   * 否则空闲首个 tick 会被误判为滞后一个周期（2026-09-04 实测修复：
   * 旧实现 start 后恒报 lag≈interval，空闲环境 5s/条误告警并污染 Sentry）。
   */
  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.lastExpectedAt = Date.now() + this.intervalMs;
    this.timer = setInterval(() => {
      this.sample();
    }, this.intervalMs);
  }

  /**
   * 停止监控（幂等；应用退出调用）
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 采集一次样本（手动触发可测；tick 自动调用）
   *
   * @param now 采样时刻（默认 Date.now()；测试可注入确定性时刻）
   */
  sample(now = Date.now()): EventLoopLagSample {
    // 首采（未启动/无基准）：仅记录基准时刻，不产生告警
    const firstSample = this.lastExpectedAt === 0;
    const lagMs = firstSample ? 0 : measureLag(this.lastExpectedAt, now);
    // 期望时刻按 interval 前移：lag 只反映"实际采样间隔超出期望间隔"的部分，
    // 而不是把正常的采样周期误判为阻塞（修复前恒报 lag≈interval 的误告警）。
    this.lastExpectedAt = now + this.intervalMs;
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
