interface GateEntry {
  readonly sessionId: string;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
  readonly signal: AbortSignal | undefined;
  readonly onDequeued: () => void;
}

export const DEFAULT_MAX_CONCURRENT_TURNS = 4;

export interface ConcurrencyGate {
  acquire(sessionId: string, signal?: AbortSignal): Promise<() => void>;
  getStats(): { readonly running: number; readonly queued: number };
}

export function createGateAbortError(): Error {
  return new DOMException('Concurrency gate aborted', 'AbortError');
}

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
