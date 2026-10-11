// concurrency-controller.ts：per-provider 并发自适应控制器——纯状态机（cap 浮动 + epoch 阻尼
// + lastGood 记忆 + 空闲重置），不读时钟不做 I/O：now（ms since epoch）一律由调用方传入。
// 参照 zcode ConcurrencyController（AIMD/纯包纪律）；闸门/定时器/队列在 concurrency-gate（包外）。
// 常量全部带理由——每个值都是取舍而非默认。

/** 限流即 cap × 0.75（不用 TCP 经典砍半：减半对「只多了一两个」的越界反应过猛——
 * 请求级闸门一次 429 很少说明高了一倍） */
export const CONCURRENCY_DECREASE_FACTOR = 0.75;
/** 加性递增步长（+1：逐步探测回上限，试探失败的代价只是一个请求吃一次 429） */
export const CONCURRENCY_INCREASE_STEP = 1;
/** 每 +1 需要的连续成功数 K（zcode 从 40 降到 4：不值得用 40 次成功换一次试探） */
export const CONCURRENCY_INCREASE_AFTER_SUCCESSES = 4;
/** 永远至少有一个探针在跑（cap 下限） */
export const CONCURRENCY_FLOOR = 1;
/** 空闲这么久（且无在飞）后遗忘学到的 cap 回天花板（限流水位会变，旧知识过期） */
export const CONCURRENCY_IDLE_RESET_MS = 300_000;

/** 控制器只读快照（测试断言/诊断投影用） */
export interface ConcurrencyControllerSnapshot {
  readonly cap: number;
  readonly ceiling: number;
  /** 限流裁决计数；准入时发给尝试、结束时带回来比对（epoch 不一致的反馈不评价 cap） */
  readonly epoch: number;
  readonly inFlight: number;
  readonly successStreak: number;
  readonly coolingDown: boolean;
  readonly lastGood: number | undefined;
  readonly lastBad: number | undefined;
}

/**
 * 单个 provider 上的 AIMD 状态机。
 *
 * 单位是「模型请求的每一次尝试」：inFlight = 已准入、尚未 release 的请求数。
 * 纯包纪律：定时器/队列/闸门都在包外——本类只回答「cap 现在多少、能不能准入、
 * 这次信号让 cap 变了没有」。
 */
export class ConcurrencyController {
  private readonly ceiling: number;
  private cap: number;
  private epoch = 0;
  private inFlight = 0;
  private successStreak = 0;
  private cooldownUntil = 0;
  private lastGood: number | undefined;
  private lastBad: number | undefined;
  private lastRequestAt: number | undefined;

  constructor(ceiling: number) {
    if (!Number.isInteger(ceiling) || ceiling <= 0) {
      throw new Error(`ConcurrencyController: ceiling 必须为正整数（收到 ${ceiling}）`);
    }
    this.ceiling = ceiling;
    this.cap = ceiling;
  }

  /** 能否准入：不超 cap 且不在冷却（冷却信息由闸门检查——这里只管 cap） */
  canAdmit(now: number): boolean {
    this.idleReset(now);
    return this.inFlight < this.cap;
  }

  /** 准入成功（闸门放行后调用）：记在飞与当时的 epoch（结束回来比对用）。
   * 空闲判定在计数更新之后——「将要变忙」的准入不触发重置（此刻确实空闲，但马上不空闲了） */
  admitted(now: number): void {
    this.inFlight += 1;
    this.idleReset(now);
    this.lastRequestAt = now;
  }

  /** 尝试成功：streak+1；满 K 次且无人排队（排队信号由调用方传）才加性增 */
  succeeded(now: number, options?: { readonly waiters?: number }): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.lastRequestAt = now;
    this.idleReset(now);
    this.successStreak += 1;
    if (this.successStreak < CONCURRENCY_INCREASE_AFTER_SUCCESSES) {
      return;
    }
    const waiters = options?.waiters ?? 0;
    if (waiters <= 0 && this.cap < this.ceiling) {
      this.cap = Math.min(this.ceiling, this.cap + CONCURRENCY_INCREASE_STEP);
      this.successStreak = 0;
    }
  }

  /** 尝试失败（限流类）：epoch 阻尼裁决 + 乘性减 + lastGood 记忆 + 冷却 */
  throttled(
    now: number,
    options?: {
      readonly cooldownMs?: number;
      readonly waiters?: number;
      /** 该失败来自 stale 请求（准入时的 epoch ≠ 当前 epoch，由闸门比对后传入）——只清 streak 刷冷却，不评价 cap */
      readonly stale?: boolean;
    },
  ): void {
    this.idleReset(now);
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.lastRequestAt = now;
    this.successStreak = 0;
    // 限流裁决计数递增：旧 epoch 的在途反馈由此自然失效（准入时带上新 epoch）
    this.epoch += 1;

    if (options?.cooldownMs !== undefined && options.cooldownMs > 0) {
      this.cooldownUntil = Math.max(this.cooldownUntil, now + options.cooldownMs);
    }

    // epoch 阻尼：stale 请求（旧 cap 世界的回声）不评价当前 cap
    if (options?.stale === true) {
      return;
    }

    // 排队者 > 0 时不砍 cap：限流发生在有排队的时刻说明压力已受控，砍了反而让等待更久
    const waiters = options?.waiters ?? 0;
    if (waiters > 0) {
      return;
    }

    if (this.lastGood !== undefined && this.cap > this.lastGood) {
      // 曾从 lastGood 探测上冲后撞墙：一步回退到已验证水位
      this.lastBad = this.cap;
      this.cap = this.lastGood;
    } else {
      const reduced = Math.max(
        CONCURRENCY_FLOOR,
        Math.floor(this.cap * CONCURRENCY_DECREASE_FACTOR),
      );
      this.lastBad = this.cap;
      this.lastGood = undefined;
      this.cap = reduced;
    }
  }

  /** 尝试失败（非限流类：网络错/超时——不评价 cap，只释放计数） */
  failed(now: number): void {
    this.idleReset(now);
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.lastRequestAt = now;
  }

  /** 冷却是否生效（闸门 acquire 前检查） */
  isCoolingDown(now: number): boolean {
    this.idleReset(now);
    return now < this.cooldownUntil;
  }

  /** 冷却剩余毫秒（闸门唤醒定时器用；非冷却期返回 0） */
  cooldownRemainingMs(now: number): number {
    this.idleReset(now);
    return Math.max(0, this.cooldownUntil - now);
  }

  snapshot(): ConcurrencyControllerSnapshot {
    return {
      cap: this.cap,
      ceiling: this.ceiling,
      epoch: this.epoch,
      inFlight: this.inFlight,
      successStreak: this.successStreak,
      coolingDown: this.cooldownUntil > 0,
      lastGood: this.lastGood,
      lastBad: this.lastBad,
    };
  }

  /** 空闲重置：无在飞且超过 IDLE_RESET_MS 后遗忘学到的 cap（旧知识过期） */
  private idleReset(now: number): void {
    if (
      this.lastRequestAt === undefined ||
      this.inFlight !== 0 ||
      now - this.lastRequestAt < CONCURRENCY_IDLE_RESET_MS
    ) {
      return;
    }
    this.cap = this.ceiling;
    this.successStreak = 0;
    this.cooldownUntil = 0;
    this.lastGood = undefined;
    this.lastBad = undefined;
    this.lastRequestAt = now;
  }
}
