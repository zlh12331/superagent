/** 队列条目 */
interface GateEntry {
  readonly sessionId: string;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  /** abort 监听（出队时移除，防泄漏） */
  readonly onAbort: () => void;
  /** 中断信号（出队时移除监听用） */
  readonly signal: AbortSignal | undefined;
  /** 出队清理（清除排队超时定时器，2026-09-08 加） */
  readonly onDequeued: () => void;
}

/**
 * 默认最大同时执行回合数
 *
 * 桌面单用户场景：4 个并发回合足以覆盖多会话同时操作，
 * 同时避免免费层 API 被打满触发 429。真源在 ServiceContainer
 * （构造 createConcurrencyGate 时传入本常量）。
 */
export const DEFAULT_MAX_CONCURRENT_TURNS = 4;

/**
 * 并发槽位门接口
 */
export interface ConcurrencyGate {
  /**
   * 获取一个执行槽位；无空位时 FIFO 排队等待。
   *
   * @param sessionId 请求方会话 id（日志/统计用）
   * @param signal 中断信号（排队期间 abort → 抛 AbortError 并让位）
   * @returns 释放函数（必须调用；幂等）
   */
  acquire(sessionId: string, signal?: AbortSignal): Promise<() => void>;
  /** 当前运行/排队统计（日志与测试断言用） */
  getStats(): { readonly running: number; readonly queued: number };
}

/** 排队期间被 abort 的错误（与回合中断同语义，上层按 AbortError 分类） */
export function createGateAbortError(): Error {
  return new DOMException('Concurrency gate aborted', 'AbortError');
}

/**
 * 默认排队获取超时（毫秒）
 *
 * 2026-09-08 加固：此前排队无 TTL——若某个运行中回合异常挂起且永不 release，
 * 后续回合会永久 pending（用户看到「一直在排队」且无任何反馈）。
 * 超时后拒绝并让出队列位置，上层按 AbortError 语义处理（回合失败可重试）。
 */
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 入队等待槽位（模块级，从 createConcurrencyGate 提取以保持其函数体精简）
 *
 * 含 abort 竞态修复（2026-09-08）：注册监听后复查 signal.aborted——
 * 首次检查与注册之间存在窗口，若 signal 在窗口内 abort，监听器不会再触发，
 * 条目会滞留队列直到被 dequeue 后照常放行（中断语义被违反）。
 *
 * 含排队超时（2026-09-08）：超时后出队并拒绝，避免槽位泄漏导致永久等待。
 *
 * @param queue FIFO 队列（调用方持有）
 * @param sessionId 会话标识
 * @param signal 中断信号（可选）
 * @param timeoutMs 排队超时（毫秒）
 */
function enqueueGateEntry(
  queue: GateEntry[],
  sessionId: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<() => void> {
  return new Promise<() => void>((resolve, reject) => {
    /** 出队并拒绝（abort / 超时共用；幂等） */
    const rejectAndDequeue = (error: Error): void => {
      const index = queue.indexOf(entry);
      if (index >= 0) {
        queue.splice(index, 1);
        clearTimeout(timeoutTimer);
        reject(error);
      }
    };
    const entry: GateEntry = {
      sessionId,
      resolve,
      reject,
      signal,
      onAbort: () => {
        rejectAndDequeue(createGateAbortError());
      },
      onDequeued: () => {
        clearTimeout(timeoutTimer);
      },
    };
    const timeoutTimer = setTimeout(() => {
      rejectAndDequeue(
        new DOMException(`Concurrency gate acquire timeout (${timeoutMs}ms)`, 'AbortError'),
      );
    }, timeoutMs);
    timeoutTimer.unref?.();
    signal?.addEventListener('abort', entry.onAbort, { once: true });
    queue.push(entry);
    if (signal?.aborted === true) {
      entry.onAbort();
    }
  });
}

/**
 * 创建并发槽位门
 *
 * @param maxConcurrent 最大同时执行回合数（必须为正整数）
 * @returns ConcurrencyGate 实例
 *
 * @example
 * ```ts
 * const gate = createConcurrencyGate(4);
 * const release = await gate.acquire(sessionId, controller.signal);
 * try {
 *   await runTurn();
 * } finally {
 *   release();
 * }
 * ```
 */
export function createConcurrencyGate(maxConcurrent: number): ConcurrencyGate {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new Error(`createConcurrencyGate: maxConcurrent 必须为正整数（收到 ${maxConcurrent}）`);
  }

  let running = 0;
  const queue: GateEntry[] = [];

  /** 出队下一个等待者（有空位时循环放行） */
  const dequeueNext = (): void => {
    while (running < maxConcurrent && queue.length > 0) {
      const entry = queue.shift() as GateEntry;
      entry.signal?.removeEventListener('abort', entry.onAbort);
      entry.onDequeued();
      running += 1;
      entry.resolve(createRelease());
    }
  };

  /** 生成独立释放函数（幂等：重复调用无害） */
  const createRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      running -= 1;
      dequeueNext();
    };
  };

  return {
    acquire(sessionId, signal) {
      if (signal?.aborted === true) {
        return Promise.reject(createGateAbortError());
      }
      if (running < maxConcurrent) {
        running += 1;
        return Promise.resolve(createRelease());
      }
      return enqueueGateEntry(queue, sessionId, signal, DEFAULT_ACQUIRE_TIMEOUT_MS);
    },
    getStats: () => ({ running, queued: queue.length }),
  };
}
