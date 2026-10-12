import type { UIMessageChunk } from 'ai';

/** 默认合并窗口（毫秒）：≈ 60fps 下 1~2 帧，打字机观感不受影响 */
export const TEXT_DELTA_BATCH_MS = 20;

/** 缓冲区字符上限：超过立即透出（高频流下避免延迟与内存累积） */
export const TEXT_DELTA_BATCH_MAX_CHARS = 4096;

/** 定时器注入点：测试可用假计时器，生产用 setTimeout */
export type Scheduler = (callback: () => void, ms: number) => () => void;

const defaultScheduler: Scheduler = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

/** 批处理器选项（emit 出口 + 合并窗口/字符上限/定时器可注入） */
export interface StreamChunkBatcherOptions {
  /** 下游出口（transport 里为 ReadableStream controller.enqueue） */
  readonly emit: (chunk: UIMessageChunk) => void;
  /** 覆盖默认合并窗口 */
  readonly batchMs?: number;
  /** 覆盖默认缓冲字符上限 */
  readonly maxChars?: number;
  /** 覆盖默认定时器 */
  readonly schedule?: Scheduler;
}

/** 批处理器接口：push 上游 chunk / flush 透出缓冲 / dispose 放弃缓冲 */
export interface StreamChunkBatcher {
  /** 推入一个上游 chunk（text-delta 可能被缓冲，其余立即透出） */
  push(chunk: UIMessageChunk): void;
  /** 立即透出缓冲内容（流结束/出错时调用；无缓冲时为 no-op） */
  flush(): void;
  /** 放弃缓冲并取消定时器（流被取消/已关闭时调用） */
  dispose(): void;
}

/**
 * 创建 text-delta 合并批处理器。
 *
 * @example
 * ```ts
 * const batcher = createStreamChunkBatcher({ emit: (chunk) => controller.enqueue(chunk) });
 * batcher.push({ type: 'text-delta', id: 't1', delta: 'he' });
 * batcher.push({ type: 'text-delta', id: 't1', delta: 'llo' });
 * batcher.flush(); // 单条 { delta: 'hello' }
 * ```
 */
/** 仅 text-delta 参与合并（缓冲后覆盖 delta 字段仍须保持类型正确） */
type TextDeltaChunk = Extract<UIMessageChunk, { type: 'text-delta' }>;

/** 创建 text-delta 合并批处理器（用法见上方 example；非 text-delta chunk 立即透出） */
export function createStreamChunkBatcher(options: StreamChunkBatcherOptions): StreamChunkBatcher {
  const { emit } = options;
  const batchMs = options.batchMs ?? TEXT_DELTA_BATCH_MS;
  const maxChars = options.maxChars ?? TEXT_DELTA_BATCH_MAX_CHARS;
  const schedule = options.schedule ?? defaultScheduler;

  let pending: { readonly chunk: TextDeltaChunk; readonly id: string; text: string } | null = null;
  let cancelTimer: (() => void) | null = null;
  let disposed = false;

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
    emit({ ...buffered.chunk, delta: buffered.text });
  };

  return {
    push(chunk) {
      if (disposed) return;
      if (chunk.type !== 'text-delta') {
        flush();
        emit(chunk);
        return;
      }
      if (pending !== null && pending.id !== chunk.id) {
        flush();
      }
      if (pending === null) {
        pending = { chunk, id: chunk.id, text: chunk.delta };
        cancelTimer = schedule(flush, batchMs);
      } else {
        pending.text += chunk.delta;
      }
      if (pending.text.length >= maxChars) {
        flush();
      }
    },
    flush,
    dispose() {
      disposed = true;
      clearTimer();
      pending = null;
    },
  };
}
