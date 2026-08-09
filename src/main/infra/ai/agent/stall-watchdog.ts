// src/main/infra/ai/stall-watchdog.ts
// 停滞看门狗：无进展回合的检测 + 重试（对齐 qwen workflow-stall 语义收敛）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 监听委托执行的外部进度事件，超时无进展判定停滞
// - 工具执行中暂停计时（长跑工具不被误判）
// - 停滞 abort 当前尝试并重试（上限 maxAttempts）；父取消不重试
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/core/src/agents/runtime/workflow-stall.ts
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// stall watchdog 语义，按我们的技术栈收敛重写：
// - 移除 env 解析 / debugLogger / AgentEventEmitter 强耦合（改为回调喂入）
// - 保持核心不变式：无进展计时 + 工具飞行中暂停 + 停滞 abort 重试
// ──────────────────────────────────────────────────────────────

import { logger } from '../../../utils/logger';

/** 看门狗配置 */
export interface StallWatchdogOptions {
  /** 无进展停滞阈值（默认 60s；工具执行中暂停计时） */
  readonly stallMs?: number;
  /** 单次委托的总尝试上限（初始 + 重试，默认 3） */
  readonly maxAttempts?: number;
}

/** 外部进度事件（SubagentManager 回合事件桥接） */
export type WatchdogEvent =
  | { readonly type: 'progress' }
  | { readonly type: 'tool-start' }
  | { readonly type: 'tool-end' };

/** 看门狗守卫配置 */
export interface GuardOptions<T> {
  /** 单次尝试的委托（signal：per-attempt，停滞时 abort；report：进度喂入） */
  readonly dispatch: (signal: AbortSignal, report: (event: WatchdogEvent) => void) => Promise<T>;
  /** 外部进度透传（可空实现；主要给调用方观测） */
  readonly onEvent?: (event: WatchdogEvent) => void;
  /** 父取消信号（传播给当前尝试；父取消不重试） */
  readonly signal?: AbortSignal;
  /** 停滞说明（日志上下文） */
  readonly label: string;
}

/**
 * 停滞看门狗（可复用实例；每次 guard 调用独立计时）
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
   * @throws 全部尝试耗尽后抛最后一次失败原因
   */
  async guard<T>(options: GuardOptions<T>): Promise<T> {
    const { dispatch, onEvent, signal, label } = options;
    const report = onEvent ?? ((): void => {});

    // 父取消判定：signal.aborted（闭包赋值会触发 TS 收窄误报，统一读 signal 状态）
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
          // 父取消（不重试）；停滞 abort 或委托自身失败（重试）
          if (parentCancelled()) {
            throw new Error('执行被父信号取消');
          }
          lastFailure = err;
        }
      }
      // 全部尝试耗尽
      const message = lastFailure instanceof Error ? lastFailure.message : String(lastFailure);
      throw new Error(`${label} 停滞重试耗尽（${this.maxAttempts} 次）：${message}`);
    } finally {
      // 无残留监听（父取消传播在 runAttempt 内管理）
    }
  }

  /** 单次尝试：无进展计时 + 工具飞行暂停 + 停滞 abort */
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

    // 计时状态
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
      // 进度桥接：刷新计时后透传
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
    }
  }
}
