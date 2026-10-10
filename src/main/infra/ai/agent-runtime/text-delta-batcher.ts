/** 默认合并窗口（毫秒）：与渲染层 TEXT_DELTA_BATCH_MS（20ms）对齐，16–20ms ≈ 1 帧 */
export const TEXT_DELTA_BATCH_MS = 20;

/** 缓冲字符上限：超过立即落地（高频流下避免延迟与内存累积） */
export const TEXT_DELTA_BATCH_MAX_CHARS = 4096;

/** 定时器注入点：测试可用假计时器 */
export type BatchScheduler = (callback: () => void, ms: number) => () => void;

const defaultScheduler: BatchScheduler = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

/** 批处理器选项（emit 出口 + 合并窗口/字符上限/定时器可注入） */
export interface TextDeltaBatcherOptions {
  /** 下游出口（agent-service 侧为 createTurnPartForwarder 内对 forwardStreamPart 的单参包装） */
  readonly emit: (part: unknown) => void;
  /** 覆盖默认合并窗口 */
  readonly batchMs?: number;
  /** 覆盖默认缓冲字符上限 */
  readonly maxChars?: number;
  /** 覆盖默认定时器 */
  readonly schedule?: BatchScheduler;
}

/** 批处理器接口：push 上游 part / flush 落地缓冲（幂等） */
export interface TextDeltaBatcher {
  /** 推入一个上游 part（text-delta 可能被缓冲，其余立即透出） */
  push(part: unknown): void;
  /** 立即透出缓冲内容（回合收尾调用；无缓冲时为 no-op） */
  flush(): void;
}

/** text-delta 判定：type 匹配且 delta 为字符串（SDK 形状漂移时退化为透传，不丢 part） */
function isBatchableTextDelta(part: unknown): part is Record<string, unknown> & { delta: string } {
  if (typeof part !== 'object' || part === null) {
    return false;
  }
  const record = part as Record<string, unknown>;
  return record['type'] === 'text-delta' && typeof record['delta'] === 'string';
}

/**
 * 创建 text-delta 合帧批处理器（主进程侧；语义与渲染层 stream-chunk-batcher 对齐）
 *
 * @example
 * ```ts
 * const batcher = createTextDeltaBatcher({ emit: (p) => forwardStreamPart(p, sessionId, wc) });
 * batcher.push({ type: 'text-delta', id: 't1', delta: 'he' });
 * batcher.push({ type: 'text-delta', id: 't1', delta: 'llo' });
 * batcher.flush(); // 单条 { type: 'text-delta', id: 't1', delta: 'hello' }
 * ```
 */
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
