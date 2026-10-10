import { app } from 'electron';
import { logger } from '../../utils/logger';

const DEFAULT_INTERVAL_MS = 60_000;
const ALERT_CONSECUTIVE_SAMPLES = 3;
const ALERT_GROWTH_MB = 150;

export interface MemorySample {
  readonly rssMb: number;
  readonly heapUsedMb: number;
  readonly externalMb: number;
  readonly at: number;
}

export interface MemoryAlertReport {
  readonly growthMb: number;
  readonly durationSec: number;
  readonly samples: readonly MemorySample[];
}

export type MemoryAlertHandler = (report: MemoryAlertReport) => void;

export interface MemoryMonitorOptions {
  readonly intervalMs?: number;
  readonly consecutiveSamples?: number;
  readonly growthMb?: number;
  readonly onAlert?: MemoryAlertHandler;
}

export function detectGrowth(
  samples: readonly MemorySample[],
  consecutive = ALERT_CONSECUTIVE_SAMPLES,
  growthMb = ALERT_GROWTH_MB,
): MemoryAlertReport | null {
  if (samples.length < consecutive + 1) {
    return null;
  }
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

export class MemoryMonitor {
  private readonly intervalMs: number;
  private readonly consecutiveSamples: number;
  private readonly growthMb: number;
  private handlers: MemoryAlertHandler[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private history: MemorySample[] = [];

  constructor(options: MemoryMonitorOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.consecutiveSamples = options.consecutiveSamples ?? ALERT_CONSECUTIVE_SAMPLES;
    this.growthMb = options.growthMb ?? ALERT_GROWTH_MB;
    if (options.onAlert !== undefined) {
      this.handlers.push(options.onAlert);
    }
  }

  onAlert(handler: MemoryAlertHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.sample();
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
    }
  }

  get running(): boolean {
    return this.timer !== null;
  }

  sample(): MemorySample {
    const mem = process.memoryUsage();
    const sample: MemorySample = {
      rssMb: mem.rss / 1024 / 1024,
      heapUsedMb: mem.heapUsed / 1024 / 1024,
      externalMb: mem.external / 1024 / 1024,
      at: Date.now(),
    };
    this.history.push(sample);
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

export function startMemoryMonitor(options: MemoryMonitorOptions = {}): () => void {
  const monitor = new MemoryMonitor(options);
  monitor.start();
  logger.info({ intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS }, '主进程内存监控已启动');
  return () => monitor.stop();
}
