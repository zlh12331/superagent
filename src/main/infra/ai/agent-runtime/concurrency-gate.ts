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

/** 并发冷却默认上限：429 Retry-After 超过此值按此封顶（防几小时的指示挂死所有回合排队） */
export const MAX_COOLDOWN_MS = 5 * 60 * 1000;

/** 并发门接口：acquire 返回 release 函数（用完必须释放）；coolDown 喂入限流冷却 */
export interface ConcurrencyGate {
  acquire(sessionId: string, signal?: AbortSignal): Promise<() => void>;
  /** 限流冷却：cooldownUntil 之前 acquire 一律排队；多次调用取最晚值（负值/NaN 忽略）；超 MAX_COOLDOWN_MS 封顶 */
  coolDown(durationMs: number): void;
  /** 是否处于冷却期（诊断/测试用） */
  isCoolingDown(): boolean;
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

/** 创建并发门（running 计数 + FIFO 队列；release 幂等防双放行；限流冷却期 acquire 一律排队） */
export function createConcurrencyGate(maxConcurrent: number): ConcurrencyGate {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new Error(`createConcurrencyGate: maxConcurrent 必须为正整数（收到 ${maxConcurrent}）`);
  }

  let running = 0;
  let cooldownUntil = 0;
  const queue: GateEntry[] = [];

  const dequeueNext = (): void => {
    while (running < maxConcurrent && queue.length > 0 && Date.now() >= cooldownUntil) {
      const entry = queue.shift() as GateEntry;
      entry.signal?.removeEventListener('abort', entry.onAbort);
      entry.onDequeued();
      running += 1;
      entry.resolve(createRelease());
    }
  };

  const armCooldownWake = (): void => {
    const waitMs = cooldownUntil - Date.now();
    if (waitMs <= 0) {
      return;
    }
    setTimeout(dequeueNext, waitMs).unref?.();
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
      // 冷却期即使有空槽也不放行：限流压力下 provider 看到的在飞数必须真正下降
      if (Date.now() >= cooldownUntil && running < maxConcurrent) {
        running += 1;
        return Promise.resolve(createRelease());
      }
      return enqueueGateEntry(queue, sessionId, signal, DEFAULT_ACQUIRE_TIMEOUT_MS);
    },
    coolDown(durationMs) {
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        return;
      }
      const candidate = Date.now() + Math.min(durationMs, MAX_COOLDOWN_MS);
      if (candidate > cooldownUntil) {
        cooldownUntil = candidate;
        armCooldownWake();
      }
    },
    isCoolingDown: () => Date.now() < cooldownUntil,
    getStats: () => ({ running, queued: queue.length }),
  };
}
