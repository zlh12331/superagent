// src/main/infra/telemetry/memory-monitor.ts
// 主进程内存监控（生产长期趋势 + 泄漏哨兵）
// ──────────────────────────────────────────────
// 职责：
// - 周期性采样 process.memoryUsage（rss/heapUsed）+ app.getAppMetrics（各进程 CPU/内存）
// - 泄漏嫌疑检测：RSS 连续 N 次采样单调增长且累计增长超阈值 → onAlert 回调
//   （日志挂载点；检测逻辑为纯函数，可单测）
// - 返回 stop（生命周期管理；定时器 unref，不阻塞进程退出）
//
// 设计（对齐 event-loop-lag.ts 语义收敛）：
// - 回调挂载点模式：监控器不感知上报通道（错误上报/electron-log 由调用方注入）
// - 保守阈值：连续 3 次（5 分钟窗口）单调增长 + 累计 > 150MB 才告警，防 GC 抖动误报
// ──────────────────────────────────────────────

import { app } from 'electron';
import { logger } from '../../utils/logger';

/** 默认采样间隔（毫秒）——60s 生产低频，开销可忽略 */
const DEFAULT_INTERVAL_MS = 60_000;
/** 告警所需连续增长采样次数（3 次 × 60s ≈ 3 分钟窗口） */
const ALERT_CONSECUTIVE_SAMPLES = 3;
/** 告警累计增长阈值（MB）——超过视为泄漏嫌疑 */
const ALERT_GROWTH_MB = 150;

/** 单次采样结果 */
export interface MemorySample {
  /** 常驻内存（MB） */
  readonly rssMb: number;
  /** JS 堆已用（MB） */
  readonly heapUsedMb: number;
  /** 外部内存（MB，原生模块缓冲区） */
  readonly externalMb: number;
  /** 采样时间戳 */
  readonly at: number;
}

/** 告警报告（泄漏嫌疑时回调负载） */
export interface MemoryAlertReport {
  /** 检测窗口内累计增长（MB） */
  readonly growthMb: number;
  /** 窗口时长（秒） */
  readonly durationSec: number;
  /** 窗口内采样序列 */
  readonly samples: readonly MemorySample[];
}

/** 回调签名 */
export type MemoryAlertHandler = (report: MemoryAlertReport) => void;

/** 监控器配置 */
export interface MemoryMonitorOptions {
  /** 采样间隔（毫秒；默认 60000） */
  readonly intervalMs?: number;
  /** 告警所需连续增长次数（默认 3） */
  readonly consecutiveSamples?: number;
  /** 告警累计增长阈值（MB；默认 150） */
  readonly growthMb?: number;
  /** 泄漏嫌疑回调（可多个） */
  readonly onAlert?: MemoryAlertHandler;
}

/**
 * 泄漏嫌疑检测纯函数（可单测）
 *
 * 规则：窗口内存在连续 N 次采样 rss 单调增长，且窗口首尾增长 > 阈值。
 * 保守设计：单次增长不告警（GC 抖动）；要求"持续单调增长"（泄漏特征）。
 *
 * @param samples 按时间升序的采样序列（至少 N+1 条）
 * @param consecutive 连续增长次数要求
 * @param growthMb 累计增长阈值（MB）
 * @returns 命中时返回告警报告，未命中返回 null
 */
export function detectGrowth(
  samples: readonly MemorySample[],
  consecutive = ALERT_CONSECUTIVE_SAMPLES,
  growthMb = ALERT_GROWTH_MB,
): MemoryAlertReport | null {
  if (samples.length < consecutive + 1) {
    return null;
  }
  // 找最长连续单调增长段（相邻采样 rss 严格递增）
  let bestStart = -1;
  let bestLen = 0;
  let runStart = 0;
  let runLen = 1;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (prev === undefined || cur === undefined) continue;
    if (cur.rssMb > prev.rssMb) {
      runLen += 1;
      if (runLen > bestLen) {
        bestLen = runLen;
        bestStart = runStart;
      }
    } else {
      runStart = i;
      runLen = 1;
    }
  }
  if (bestLen < consecutive || bestStart < 0) {
    return null;
  }
  const startSample = samples[bestStart];
  const endSample = samples[bestStart + bestLen - 1];
  if (startSample === undefined || endSample === undefined) {
    return null;
  }
  const growth = endSample.rssMb - startSample.rssMb;
  if (growth <= growthMb) {
    return null;
  }
  return {
    growthMb: growth,
    durationSec: (endSample.at - startSample.at) / 1000,
    samples: samples.slice(bestStart, bestStart + bestLen),
  };
}

/**
 * 主进程内存监控器
 */
export class MemoryMonitor {
  private readonly intervalMs: number;
  private readonly consecutiveSamples: number;
  private readonly growthMb: number;
  private handlers: MemoryAlertHandler[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 采样历史（窗口滑动，保留最近 N 条供检测） */
  private history: MemorySample[] = [];

  constructor(options: MemoryMonitorOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.consecutiveSamples = options.consecutiveSamples ?? ALERT_CONSECUTIVE_SAMPLES;
    this.growthMb = options.growthMb ?? ALERT_GROWTH_MB;
    if (options.onAlert !== undefined) {
      this.handlers.push(options.onAlert);
    }
  }

  /** 订阅泄漏告警（可多个订阅者），返回退订函数 */
  onAlert(handler: MemoryAlertHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /** 启动监控（幂等；定时器 unref——不阻止应用退出） */
  start(): void {
    if (this.timer !== null) {
      return;
    }
    // 首采建立基线（不检测）
    this.sample();
    const timer = setInterval(() => {
      this.sample();
    }, this.intervalMs);
    timer.unref();
    this.timer = timer;
  }

  /** 停止监控（幂等） */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 当前是否运行中 */
  get running(): boolean {
    return this.timer !== null;
  }

  /** 采集一次样本（手动触发可测；tick 自动调用） */
  sample(): MemorySample {
    const mem = process.memoryUsage();
    const sample: MemorySample = {
      rssMb: mem.rss / 1024 / 1024,
      heapUsedMb: mem.heapUsed / 1024 / 1024,
      externalMb: mem.external / 1024 / 1024,
      at: Date.now(),
    };
    this.history.push(sample);
    // 窗口滑动：只保留 2 倍告警窗口所需样本（防历史无限增长）
    const maxHistory = this.consecutiveSamples * 2 + 2;
    if (this.history.length > maxHistory) {
      this.history = this.history.slice(-maxHistory);
    }
    const report = detectGrowth(this.history, this.consecutiveSamples, this.growthMb);
    if (report !== null) {
      for (const handler of this.handlers) {
        handler(report);
      }
    }
    return sample;
  }

  /** 各进程内存概览（诊断辅助，告警时随报告输出） */
  static processMetrics(): Record<string, { cpu: number; memory: number }> {
    const metrics: Record<string, { cpu: number; memory: number }> = {};
    for (const proc of app.getAppMetrics()) {
      metrics[proc.type] = {
        cpu: proc.cpu.percentCPUUsage,
        memory: proc.memory.workingSetSize / 1024 / 1024,
      };
    }
    return metrics;
  }
}

/** 便捷启动：采样 + 告警日志（上报由调用方挂 onAlert） */
export function startMemoryMonitor(options: MemoryMonitorOptions = {}): () => void {
  const monitor = new MemoryMonitor(options);
  monitor.start();
  logger.info({ intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS }, '主进程内存监控已启动');
  return () => monitor.stop();
}
