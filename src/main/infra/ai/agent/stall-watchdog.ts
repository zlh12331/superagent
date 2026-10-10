import { logger } from '../../../utils/logger';

export interface StallWatchdogOptions {
  readonly stallMs?: number;
  readonly maxAttempts?: number;
}

export type WatchdogEvent =
  | { readonly type: 'progress' }
  | { readonly type: 'tool-start' }
  | { readonly type: 'tool-end' };

export interface GuardOptions<T> {
  readonly dispatch: (signal: AbortSignal, report: (event: WatchdogEvent) => void) => Promise<T>;
  readonly onEvent?: (event: WatchdogEvent) => void;
  readonly signal?: AbortSignal;
  readonly label: string;
}

export class StallWatchdog {
  private readonly stallMs: number;
  private readonly maxAttempts: number;

  constructor(options?: StallWatchdogOptions) {
    this.stallMs = options?.stallMs ?? 60_000;
    this.maxAttempts = options?.maxAttempts ?? 3;
  }

  async guard<T>(options: GuardOptions<T>): Promise<T> {
    const { dispatch, onEvent, signal, label } = options;
    const report = onEvent ?? ((): void => {});

    const parentCancelled = (): boolean => signal?.aborted ?? false;

    try {
      let lastFailure: unknown = new Error('未执行');
      for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
        if (parentCancelled()) {
          throw new Error('执行被父信号取消');
        }
        if (attempt > 1) {
          logger.warn({ label, attempt }, '停滞触发重试');
        }
        try {
          return await this.runAttempt(dispatch, report, signal, label);
        } catch (err: unknown) {
          if (parentCancelled()) {
            throw new Error('执行被父信号取消');
          }
          lastFailure = err;
        }
      }
      const message = lastFailure instanceof Error ? lastFailure.message : String(lastFailure);
      throw new Error(`${label} 停滞重试耗尽（${this.maxAttempts} 次）：${message}`);
    } finally {
    }
  }

  private async runAttempt<T>(
    dispatch: (signal: AbortSignal, report: (event: WatchdogEvent) => void) => Promise<T>,
    report: (event: WatchdogEvent) => void,
    parentSignal: AbortSignal | undefined,
    label: string,
  ): Promise<T> {
    const controller = new AbortController();
    const parentListener = (): void => controller.abort('parent-cancelled');
    if (parentSignal !== undefined) {
      parentSignal.addEventListener('abort', parentListener);
    }

    let lastProgressAt = Date.now();
    let toolInFlight = false;
    let stalled = false;
    const timer = setInterval(
      () => {
        if (stalled || toolInFlight || controller.signal.aborted) {
          return;
        }
        if (Date.now() - lastProgressAt > this.stallMs) {
          stalled = true;
          logger.warn({ label, stallMs: this.stallMs }, '检测到执行停滞');
          controller.abort('stalled');
        }
      },
      Math.min(this.stallMs, 1_000),
    );

    try {
      const bridged: (event: WatchdogEvent) => void = (event) => {
        if (event.type === 'tool-start') {
          toolInFlight = true;
        } else if (event.type === 'tool-end') {
          toolInFlight = false;
          lastProgressAt = Date.now();
        } else {
          lastProgressAt = Date.now();
        }
        report(event);
      };
      return await dispatch(controller.signal, bridged);
    } finally {
      clearInterval(timer);
      if (parentSignal !== undefined) {
        parentSignal.removeEventListener('abort', parentListener);
      }
    }
  }
}
