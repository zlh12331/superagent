// concurrency-gate.ts：模型请求并发门——per-provider 分桶（每桶独立 cap/冷却/FIFO 队列），
// 桶内接 ConcurrencyController（AIMD）。acquire 按 providerKey 选桶，退避 sleep 期间不持票。
// 定时器（冷却唤醒/acquire 超时）在本文件——controller 保持纯状态机。
import { ConcurrencyController } from './concurrency-controller';

interface GateEntry {
  readonly sessionId: string;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
  readonly signal: AbortSignal | undefined;
  readonly onDequeued: () => void;
}

/** 每桶并发上限默认值：4（LLM 网关并发约束 + 内存考量；容器初始化传此常量） */
export const DEFAULT_MAX_CONCURRENT_PER_PROVIDER = 4;

/** 限流冷却默认上限：429 Retry-After 超过此值按此封顶（防几小时的指示挂死桶内所有请求） */
export const MAX_COOLDOWN_MS = 5 * 60 * 1000;

/** 并发门接口：acquire 返回 release 函数（用完必须释放）；coolDown 喂入限流冷却。
 * providerKey（providerKind）是配额键——同一 provider 的所有请求共享一个桶。 */
export interface ConcurrencyGate {
  acquire(providerKey: string, sessionId: string, signal?: AbortSignal): Promise<() => void>;
  /** 限流冷却：仅作用于该 provider 的桶；多次调用取最晚值；超 MAX_COOLDOWN_MS 封顶 */
  coolDown(providerKey: string, durationMs: number): void;
  /** 该 provider 桶是否处于冷却期（诊断/测试用） */
  isCoolingDown(providerKey: string): boolean;
  /** 等待该 provider 冷却结束（不占闸位；side query 经 modelGate 调用） */
  waitCooldown(providerKey: string): Promise<void>;
  /** 该 provider 桶的控制器快照（观测/测试用；桶未创建返回 undefined） */
  bucketSnapshot(providerKey: string): ReturnType<ConcurrencyController['snapshot']> | undefined;
  getStats(): { running: number; queued: number };
}

/** 排队被中止时抛的错误（与 AbortError 同形，上游统一按中止处理） */
export function createGateAbortError(): Error {
  return new DOMException('Concurrency gate aborted', 'AbortError');
}

// 排队等待上限 10 分钟：防队列堆积死等（上游 bug 不释放槽位时排队者也能脱身）
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 10 * 60 * 1000;

interface GateBucket {
  readonly controller: ConcurrencyController;
  readonly queue: GateEntry[];
}

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

/**
 * 创建分桶并发门。
 *
 * 每桶：ConcurrencyController（AIMD 状态机，cap/冷却/epoch）+ FIFO 队列。
 * 冷却期即使有空槽也不放行（provider 看到的在飞数必须真正下降）；
 * 有等待者时不走快路径（公平性：防请求密集的调用方越过队列）。
 * 桶惰性创建（用到哪个 provider 建哪个）。
 */
export function createConcurrencyGate(maxConcurrentPerProvider: number): ConcurrencyGate {
  if (!Number.isInteger(maxConcurrentPerProvider) || maxConcurrentPerProvider <= 0) {
    throw new Error(
      `createConcurrencyGate: maxConcurrentPerProvider 必须为正整数（收到 ${maxConcurrentPerProvider}）`,
    );
  }

  const buckets = new Map<string, GateBucket>();

  const getBucket = (providerKey: string): GateBucket => {
    let bucket = buckets.get(providerKey);
    if (bucket === undefined) {
      bucket = {
        controller: new ConcurrencyController(maxConcurrentPerProvider),
        queue: [],
      };
      buckets.set(providerKey, bucket);
    }
    return bucket;
  };

  const dequeueNext = (bucket: GateBucket, providerKey: string): void => {
    const now = Date.now();
    while (
      bucket.queue.length > 0 &&
      !bucket.controller.isCoolingDown(now) &&
      bucket.controller.canAdmit(now)
    ) {
      const entry = bucket.queue.shift() as GateEntry;
      entry.signal?.removeEventListener('abort', entry.onAbort);
      entry.onDequeued();
      bucket.controller.admitted(now);
      entry.resolve(createRelease(bucket, providerKey));
    }
  };

  const armCooldownWake = (bucket: GateBucket, providerKey: string): void => {
    const waitMs = bucket.controller.cooldownRemainingMs(Date.now());
    if (waitMs <= 0) {
      return;
    }
    setTimeout(() => {
      dequeueNext(bucket, providerKey);
    }, waitMs).unref?.();
  };

  const createRelease = (bucket: GateBucket, providerKey: string): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // S2b 阶段计数闭环在 gate 层：acquire +1 / release -1（forceRelease 无学习信号）。
      // S2c 尝试级准入接线后，改为「终态上报负责学习与回减、release 只唤醒队列」
      bucket.controller.forceRelease();
      dequeueNext(bucket, providerKey);
    };
  };

  return {
    acquire(providerKey, sessionId, signal) {
      if (signal?.aborted === true) {
        return Promise.reject(createGateAbortError());
      }
      const bucket = getBucket(providerKey);
      const now = Date.now();
      // 有等待者时不走快路径（公平性）；冷却期即使有空槽也不放行
      if (
        bucket.queue.length === 0 &&
        !bucket.controller.isCoolingDown(now) &&
        bucket.controller.canAdmit(now)
      ) {
        bucket.controller.admitted(now);
        return Promise.resolve(createRelease(bucket, providerKey));
      }
      return enqueueGateEntry(bucket.queue, sessionId, signal, DEFAULT_ACQUIRE_TIMEOUT_MS);
    },
    coolDown(providerKey, durationMs) {
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        return;
      }
      const bucket = getBucket(providerKey);
      // MAX_COOLDOWN_MS 封顶在闸做（controller 不知道闸的常量边界）
      const capped = Math.min(durationMs, MAX_COOLDOWN_MS);
      bucket.controller.throttleCooldown(Date.now(), capped);
      armCooldownWake(bucket, providerKey);
    },
    isCoolingDown(providerKey) {
      return buckets.get(providerKey)?.controller.isCoolingDown(Date.now()) === true;
    },
    async waitCooldown(providerKey) {
      const bucket = buckets.get(providerKey);
      while (bucket !== undefined) {
        const waitMs = bucket.controller.cooldownRemainingMs(Date.now());
        if (waitMs <= 0) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    },
    bucketSnapshot(providerKey) {
      return buckets.get(providerKey)?.controller.snapshot();
    },
    getStats() {
      let running = 0;
      let queued = 0;
      for (const bucket of buckets.values()) {
        running += bucket.controller.snapshot().inFlight;
        queued += bucket.queue.length;
      }
      return { running, queued };
    },
  };
}
