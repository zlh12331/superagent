// concurrency-gate.ts：回合并发门——全局最多 4 回合并行，超出按 FIFO 排队（AbortSignal 可取消排队）
interface GateEntry {
  readonly sessionId: string;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
  readonly signal: AbortSignal | undefined;
  readonly onDequeued: () => void;
}

/** 并发上限默认值：4 槽（LLM 网关并发约束 + 内存考量；容器初始化传此常量） */
export const DEFAULT_MAX_CONCURRENT_TURNS = 4;

/** 并发门接口：acquire 返回 release 函数（用完必须释放） */
export interface ConcurrencyGate {
  acquire(sessionId: string, signal?: AbortSignal): Promise<() => void>;
  getStats(): { readonly running: number; readonly queued: number };
}

/** 排队被中止时抛的错误（与 AbortError 同形，上游统一按中止处理） */
export function createGateAbortError(): Error {
  return new DOMException('Concurrency gate aborted', 'AbortError');
}

// 排队等待上限 10 分钟：防队列堆积死等（上游Bug 不释放槽位时排队者也能脱身）
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 10 * 60 * 1000;

function enqueueGateEntry(
  queue: GateEntry[],
  sessionId: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<() => void> {
  return new Promise<() => void>((resolve, reject) => {
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

/** 创建并发门（running 计数 + FIFO 队列；release 幂等防双放行） */
export function createConcurrencyGate(maxConcurrent: number): ConcurrencyGate {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new Error(`createConcurrencyGate: maxConcurrent 必须为正整数（收到 ${maxConcurrent}）`);
  }

  let running = 0;
  const queue: GateEntry[] = [];

  const dequeueNext = (): void => {
    while (running < maxConcurrent && queue.length > 0) {
      const entry = queue.shift() as GateEntry;
      entry.signal?.removeEventListener('abort', entry.onAbort);
      entry.onDequeued();
      running += 1;
      entry.resolve(createRelease());
    }
  };

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
