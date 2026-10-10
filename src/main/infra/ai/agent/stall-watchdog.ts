// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的

import { logger } from '../../../utils/logger';

/** 看门狗配置（构造期一次性读取，实例内不再变更） */
export interface StallWatchdogOptions {
  /** 无进展停滞阈值（毫秒，默认 60_000；工具执行中暂停计时） */
  readonly stallMs?: number;
  /** 单次委托的总尝试上限（初始 + 重试，默认 3） */
  readonly maxAttempts?: number;
}

/**
 * 外部进度事件（由 SubagentManager 把回合事件桥接为此三态）
 *
 * - progress：有推理进展（如流式文本增量），刷新计时
 * - tool-start：工具开始执行，暂停计时
 * - tool-end：工具执行结束，恢复计时并刷新
 */
export type WatchdogEvent =
  | { readonly type: 'progress' }
  | { readonly type: 'tool-start' }
  | { readonly type: 'tool-end' };

/** 看门狗守卫配置 */
export interface GuardOptions<T> {
  /**
   * 单次尝试的委托执行体
   *
   * @param signal per-attempt 信号：停滞或父取消时被 abort，dispatch 应据此中止自身
   * @param report 进度喂入回调：dispatch 主动上报 progress / tool-start / tool-end
   */
  readonly dispatch: (signal: AbortSignal, report: (event: WatchdogEvent) => void) => Promise<T>;
  /** 外部进度透传（可空实现；仅给调用方观测，不参与计时判定） */
  readonly onEvent?: (event: WatchdogEvent) => void;
  /** 父取消信号（传播给当前尝试；父取消不重试，见 guard） */
  readonly signal?: AbortSignal;
  /** 停滞说明（日志上下文：重试告警与停滞告警均携带） */
  readonly label: string;
}

/**
 * 停滞看门狗（可复用实例；配置在构造期固定，每次 guard 调用独立计时）
 *
 * 语义（对齐 qwen workflow-stall）：
 * - progress：任何推理进展（流式文本/回合推进）刷新计时
 * - tool-start：工具执行中**暂停**计时（长跑工具豁免）
 * - tool-end：恢复计时
 * - 停滞：abort 当前尝试 → 重试；父取消 → 立即传播不重试
 */
export class StallWatchdog {
  private readonly stallMs: number;
  private readonly maxAttempts: number;

  constructor(options?: StallWatchdogOptions) {
    this.stallMs = options?.stallMs ?? 60_000;
    this.maxAttempts = options?.maxAttempts ?? 3;
  }

  /**
   * 带停滞防护的委托执行
   *
   * 重试语义：
   * - 每轮尝试前先查父取消（已取消则不发起委派）；尝试抛错后若父已取消则不重试
   * - 停滞 abort 或委托自身失败 → 记 lastFailure 后进入下一轮
   * - 全部尝试耗尽 → 抛聚合错误，携带最后一次失败信息
   *
   * @throws 全部尝试耗尽后抛 `${label} 停滞重试耗尽（maxAttempts 次）：<最后失败信息>`
   * @throws 父取消时抛「执行被父信号取消」
   */
  async guard<T>(options: GuardOptions<T>): Promise<T> {
    const { dispatch, onEvent, signal, label } = options;
    const report = onEvent ?? ((): void => {});

    const parentCancelled = (): boolean => signal?.aborted ?? false;

    try {
      let lastFailure: unknown = new Error('未执行');
      for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
        if (parentCancelled()) {
          throw new Error('执行被父信号取消');
        }
        if (attempt > 1) {
          logger.warn({ label, attempt }, '停滞触发重试');
        }
        try {
          return await this.runAttempt(dispatch, report, signal, label);
        } catch (err: unknown) {
          if (parentCancelled()) {
            throw new Error('执行被父信号取消');
          }
          lastFailure = err;
        }
      }
      const message = lastFailure instanceof Error ? lastFailure.message : String(lastFailure);
      throw new Error(`${label} 停滞重试耗尽（${this.maxAttempts} 次）：${message}`);
    } finally {
    }
  }

  /**
   * 单次尝试：无进展计时 + 工具飞行暂停 + 停滞 abort
   *
   * 每轮新建独立 AbortController（per-attempt），并把父 signal 的 abort 桥接到它；
   * 无论成功失败都在 finally 清理轮询定时器与父 signal 监听（见下方 2026-09-08 修复）。
   */
  private async runAttempt<T>(
    dispatch: (signal: AbortSignal, report: (event: WatchdogEvent) => void) => Promise<T>,
    report: (event: WatchdogEvent) => void,
    parentSignal: AbortSignal | undefined,
    label: string,
  ): Promise<T> {
    const controller = new AbortController();
    const parentListener = (): void => controller.abort('parent-cancelled');
    if (parentSignal !== undefined) {
      parentSignal.addEventListener('abort', parentListener);
    }

    let lastProgressAt = Date.now();
    let toolInFlight = false;
    let stalled = false;
    const timer = setInterval(
      () => {
        if (stalled || toolInFlight || controller.signal.aborted) {
          return;
        }
        if (Date.now() - lastProgressAt > this.stallMs) {
          stalled = true;
          logger.warn({ label, stallMs: this.stallMs }, '检测到执行停滞');
          controller.abort('stalled');
        }
      },
      Math.min(this.stallMs, 1_000),
    );

    try {
      const bridged: (event: WatchdogEvent) => void = (event) => {
        if (event.type === 'tool-start') {
          toolInFlight = true;
        } else if (event.type === 'tool-end') {
          toolInFlight = false;
          lastProgressAt = Date.now();
        } else {
          lastProgressAt = Date.now();
        }
        report(event);
      };
      return await dispatch(controller.signal, bridged);
    } finally {
      clearInterval(timer);
      if (parentSignal !== undefined) {
        parentSignal.removeEventListener('abort', parentListener);
      }
    }
  }
}
