// src/main/infra/ai/agent-runtime/active-session-registry.ts
// 活跃会话注册表（R2 去重）
// ──────────────────────────────────────────────────────────────
// ChatService 与 AgentService 此前各自维护 activeSessions/activeStreams 双 Map
// 与同一套防重/中断/等待收尾逻辑（约 100 行重复），语义修正需双处同步。
// 本类收敛为共享实现：
// - preemptExisting：防重（abort 旧会话 + 等待旧 stream 退出，超时兜底）
// - abort：立即删除 controller 再 abort（配合 CAS 删除避免误删新会话）
// - removeXIfCurrent：CAS 删除（旧 stream finally 时只删自己的条目）
// - dispose：abortAll + 等待全部 stream 完成（超时兜底后强制清空）
// ──────────────────────────────────────────────────────────────

import { logger } from '../../../utils/logger';

/** 等待旧 stream 退出的兜底超时（防重检查用） */
const PREEMPT_WAIT_MS = 5000;

/**
 * 活跃会话注册表：sessionId → { AbortController, stream Promise }
 *
 * 每个服务（Chat/Agent）持有独立实例，互不共享会话 id 空间。
 */
export class ActiveSessionRegistry {
  /** 活跃会话的 AbortController（sessionId → controller） */
  private readonly controllers = new Map<string, AbortController>();
  /** 活跃 stream Promise（catch 后恒 fulfilled） */
  private readonly streams = new Map<string, Promise<void>>();

  /** 当前活跃会话数（关窗协商用：>0 表示有回合在跑） */
  get activeCount(): number {
    return this.controllers.size;
  }

  /** 获取指定会话的 controller（无活跃会话返回 undefined） */
  getController(sessionId: string): AbortController | undefined {
    return this.controllers.get(sessionId);
  }

  /**
   * 防重：若同 sessionId 已有活跃会话，abort 旧会话并等待旧 stream 退出
   *
   * 触发场景：用户快速双击发送、stop 后立即 send、跨入口并发 IPC。
   * 超时兜底避免旧 stream 卡死时阻塞调用方。
   */
  async preemptExisting(sessionId: string, kind: string): Promise<void> {
    const existingController = this.controllers.get(sessionId);
    if (existingController === undefined) {
      return;
    }
    logger.warn({ sessionId }, `检测到已有活跃 ${kind} stream，先中断旧 stream`);
    existingController.abort();
    const existingStream = this.streams.get(sessionId);
    if (existingStream !== undefined) {
      // 等待旧 stream 真正退出（最多 PREEMPT_WAIT_MS 兜底，避免卡死调用方）
      await Promise.race([
        existingStream,
        new Promise<void>((resolve) => setTimeout(resolve, PREEMPT_WAIT_MS)),
      ]);
    }
  }

  /** 注册新会话（controller + stream Promise） */
  register(sessionId: string, controller: AbortController, stream: Promise<void>): void {
    this.controllers.set(sessionId, controller);
    this.streams.set(sessionId, stream);
  }

  /**
   * 中断指定会话
   *
   * 立即从 Map 删除 controller 再 abort，避免竞态：
   *   T0: abort(sessionId) → controller.abort()
   *   T1: startXxx(sessionId) → register(sessionId, newController)
   *   T2: 旧 stream 的 finally → 若未删除则误删新 controller
   *
   * @returns 是否成功中断（无活跃会话返回 false）
   */
  abort(sessionId: string): boolean {
    const controller = this.controllers.get(sessionId);
    if (controller === undefined) {
      return false;
    }
    this.controllers.delete(sessionId);
    controller.abort();
    return true;
  }

  /** 中断所有活跃会话（同步触发 abort 信号，不等待流协程响应） */
  abortAll(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
  }

  /** CAS 删除 controller：旧 stream finally 时仅当 Map 仍是自己才删除（防误删新会话） */
  removeControllerIfCurrent(sessionId: string, controller: AbortController): boolean {
    if (this.controllers.get(sessionId) === controller) {
      this.controllers.delete(sessionId);
      return true;
    }
    return false;
  }

  /** CAS 删除 stream：旧 stream finally 时仅当 Map 仍是自己才删除 */
  removeStreamIfCurrent(sessionId: string, stream: Promise<void>): boolean {
    if (this.streams.get(sessionId) === stream) {
      this.streams.delete(sessionId);
      return true;
    }
    return false;
  }

  /**
   * 优雅关闭：abort 全部 + 等待所有活跃 stream 真正完成（带超时兜底）
   *
   * 超时后强制清空 Map（stream 协程可能仍在运行，避免进程退出 hang 死）。
   *
   * @param timeoutMs 超时毫秒数，默认 3000ms
   */
  async dispose(timeoutMs = 3000): Promise<void> {
    // 1. 触发所有 abort 信号
    this.abortAll();

    // 2. 收集所有活跃 stream Promise
    const streams = Array.from(this.streams.values());
    if (streams.length === 0) {
      return;
    }

    // 3. 等待所有 stream 完成或超时（allSettled：stream 内部已 catch，双保险）
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutId = setTimeout(() => {
        logger.warn(
          { streamCount: streams.length, timeoutMs },
          'ActiveSessionRegistry dispose 超时，强制清空',
        );
        resolve();
      }, timeoutMs);
    });

    try {
      await Promise.race([Promise.allSettled(streams), timeoutPromise]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }

    // 4. 清空 Map（即使超时也清空，避免内存泄漏；后续注册同 id 不会冲突）
    this.controllers.clear();
    this.streams.clear();
  }
}
