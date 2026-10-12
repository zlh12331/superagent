// text-delta-batcher.ts：text-delta 流事件合批——20ms 窗口或 4096 字符先到先发，
// 削峰渲染层 IPC 事件量（模型高频小 delta 直发会打爆通道）
export const TEXT_DELTA_BATCH_MS = 20;

export const TEXT_DELTA_BATCH_MAX_CHARS = 4096;

/** 调度注入缝（测试用 fake timer 替换 setTimeout） */
export type BatchScheduler = (callback: () => void, ms: number) => () => void;

const defaultScheduler: BatchScheduler = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

export interface TextDeltaBatcherOptions {
  readonly emit: (part: unknown) => void;
  readonly batchMs?: number;
  readonly maxChars?: number;
  readonly schedule?: BatchScheduler;
}

export interface TextDeltaBatcher {
  push(part: unknown): void;
  flush(): void;
}

function isBatchableTextDelta(part: unknown): part is Record<string, unknown> & { delta: string } {
  if (typeof part !== 'object' || part === null) {
    return false;
  }
  const record = part as Record<string, unknown>;
  return record['type'] === 'text-delta' && typeof record['delta'] === 'string';
}

export function createTextDeltaBatcher(options: TextDeltaBatcherOptions): TextDeltaBatcher {
  const { emit } = options;
  const batchMs = options.batchMs ?? TEXT_DELTA_BATCH_MS;
  const maxChars = options.maxChars ?? TEXT_DELTA_BATCH_MAX_CHARS;
  const schedule = options.schedule ?? defaultScheduler;

  let pending: {
    readonly template: Record<string, unknown>;
    readonly id: unknown;
    text: string;
  } | null = null;
  let cancelTimer: (() => void) | null = null;

  const clearTimer = (): void => {
    if (cancelTimer === null) return;
    cancelTimer();
    cancelTimer = null;
  };

  const flush = (): void => {
    clearTimer();
    if (pending === null) return;
    const buffered = pending;
    pending = null;
    emit({ ...buffered.template, delta: buffered.text });
  };

  return {
    push(part) {
      if (!isBatchableTextDelta(part)) {
        flush();
        emit(part);
        return;
      }
      const id = part['id'];
      if (pending !== null && pending.id !== id) {
        flush();
      }
      if (pending === null) {
        const { delta, ...template } = part;
        pending = { template, id, text: delta };
        cancelTimer = schedule(flush, batchMs);
      } else {
        pending.text += part.delta;
      }
      if (pending.text.length >= maxChars) {
        flush();
      }
    },
    flush,
  };
}
