// src/renderer/lib/agent/stream-chunk-batcher.ts
// 流式 text-delta 出口合并器（把「每 token 一次提交」降为「每窗口一次提交」）
// ──────────────────────────────────────────────────────────────
// 动机：主进程每收到一个 token 就推一条 agent:stream:part，transport 原样 enqueue ⇒
// useChat 每 token setState 一次 ⇒ 流式消息的 react-markdown 全量重解析每 token 跑一次
// （单次 O(消息长度)，整条回复累计 O(n²)）。
// 合并相邻 text-delta 后，DOM 提交次数由时间窗上限决定（≈50 次/秒），与 token 数解耦。
// ──────────────────────────────────────────────────────────────
// 约束：
// - 仅合并「同一条 text part（id 相同）且相邻」的 delta，其余 chunk 一律立即透出
// - 透出顺序与入队顺序一致：任何非合并 chunk 前先把缓冲 delta 落地
// - flush 幂等；dispose 取消定时器且不再透出（流已关闭/取消时使用）

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

export function createStreamChunkBatcher(options: StreamChunkBatcherOptions): StreamChunkBatcher {
  const { emit } = options;
  const batchMs = options.batchMs ?? TEXT_DELTA_BATCH_MS;
  const maxChars = options.maxChars ?? TEXT_DELTA_BATCH_MAX_CHARS;
  const schedule = options.schedule ?? defaultScheduler;

  // 缓冲：合并后的 chunk 模板（保留首条的 id/providerMetadata 等非 delta 字段）
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
        // 顺序保证：非 delta chunk 前必须先落地缓冲
        flush();
        emit(chunk);
        return;
      }
      // 不同 text part（id 不同）不可合并；相邻同 id 才累积
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
