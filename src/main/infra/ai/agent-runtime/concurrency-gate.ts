// src/main/infra/ai/agent-runtime/concurrency-gate.ts
// 回合级并发公平调度：多会话共享执行槽位（FIFO 先来先得）
// ──────────────────────────────────────────────────────────────
// 背景：多会话可同时发起 Agent 回合（chat / agent 共用），无并发上限时
// 会同时打满供应商 API（免费层极易触发 429）。本门提供全局槽位，
// 超过上限的回合进入 FIFO 队列等待——先到先得即"平均分配"
// （不会出现某会话被持续饿死），队列内 abort 立即让位。
//
// 设计：
// - 纯函数 + 零依赖（不依赖 logger / config / telemetry，便于单测）
// - acquire 返回幂等释放函数（重复调用无害），调用方 finally 释放
// - signal 贯穿：排队期间 abort → 移除队列并抛 AbortError（与回合
//   中断同语义，走上层统一错误分类）
// - 可选注入：service 未注入 gate 时跳过（保持原并发行为，测试兼容）
// ──────────────────────────────────────────────────────────────

/** 队列条目 */
interface GateEntry {
  readonly sessionId: string;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  /** abort 监听（出队时移除，防泄漏） */
  readonly onAbort: () => void;
  /** 中断信号（出队时移除监听用） */
  readonly signal: AbortSignal | undefined;
}

/**
 * 默认最大同时执行回合数
 *
 * 桌面单用户场景：4 个并发回合足以覆盖多会话同时操作，
 * 同时避免免费层 API 被打满触发 429。
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
  // FIFO 等待队列（先入先出 = 公平调度，无饥饿）
  const queue: GateEntry[] = [];

  /** 出队下一个等待者（有空位时循环放行） */
  const dequeueNext = (): void => {
    while (running < maxConcurrent && queue.length > 0) {
      const entry = queue.shift() as GateEntry;
      // 出队即放行：移除 abort 监听（防泄漏），占用槽位
      entry.signal?.removeEventListener('abort', entry.onAbort);
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
      // 已中断：直接失败（不排队）
      if (signal?.aborted === true) {
        return Promise.reject(createGateAbortError());
      }
      // 有空位：立即放行
      if (running < maxConcurrent) {
        running += 1;
        return Promise.resolve(createRelease());
      }
      // 排队等待（FIFO）
      return new Promise<() => void>((resolve, reject) => {
        const entry: GateEntry = {
          sessionId,
          resolve,
          reject,
          signal,
          onAbort: () => {
            const index = queue.indexOf(entry);
            if (index >= 0) {
              queue.splice(index, 1);
              reject(createGateAbortError());
            }
          },
        };
        // 排队期间 abort：移除队列并拒绝（让位给后续会话）
        signal?.addEventListener('abort', entry.onAbort, { once: true });
        queue.push(entry);
      });
    },
    getStats: () => ({ running, queued: queue.length }),
  };
}
