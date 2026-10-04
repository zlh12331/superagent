// src/main/infra/ai/agent-runtime/text-delta-batcher.ts
// text-delta 微批合帧（主进程出口侧）：把「每 token 一次 IPC 推送」合并为「每窗口一次」
// ──────────────────────────────────────────────────────────────
// 动机（P2-31）：TurnRunner 每 part 回调 onPart → 宿主闭包 pushPart →
//   partForwarder.push（本模块）→ forwardStreamPart 逐条 webContents.send，
//   长回复高频 token 下 IPC 消息数与 token 数线性相关。
//   相邻 text-delta 在窗口（16–20ms）内合并为单条 part 推送后，IPC 消息数
//   与窗口数挂钩而非 token 数。渲染层已有对偶实现
//   （src/renderer/lib/agent/stream-chunk-batcher.ts，合并相邻同 id text-delta），
//   本模块是主进程侧同构：两侧窗口重叠不叠加（≈同帧内一次 DOM 提交）。
//
// 顺序保证（不丢 part、不乱序）：
// - 仅合并「同一条 text part（id 相同）且相邻」的 delta
// - 任何非 text-delta part（含 delta 非字符串的形状漂移 part）前先落地缓冲，
//   保持发射顺序与上游一致
// - flush 幂等；回合结束/错误路径在推送 END/ERROR 前显式 flush（机器终态
//   entry 的 flushForwarder action + 宿主各 finalize 实现首步，双保险均幂等），
//   防丢尾
// ──────────────────────────────────────────────────────────────

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

  // 缓冲：合并后的 part 模板（保留首条除 delta 外的全部字段，如 id）+ 累积文本
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
      // 非 text-delta（或 delta 非字符串的形状漂移 part）：先落地缓冲再透传，保序
      if (!isBatchableTextDelta(part)) {
        flush();
        emit(part);
        return;
      }
      // 不同 text part（id 不同）不可合并；先落地前一条
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
