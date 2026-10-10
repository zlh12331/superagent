// active-session-registry.ts：活跃会话登记表——会话 → AbortController/stream 的映射，
// 支撑抢占（同会话新流踢旧流）、单会话中止、全量中止与退出排水
import { logger } from '../../../utils/logger';

// 抢占时等旧流退场最长 5s：超时不等了（旧流事件继续来的话由调用方按代际丢弃）
const PREEMPT_WAIT_MS = 5000;

/** 活跃会话登记表（每会话至多一条流；条件移除防旧流清掉新流登记） */
export class ActiveSessionRegistry {
  private readonly controllers = new Map<string, AbortController>();
  private readonly streams = new Map<string, Promise<void>>();

  /** 当前活跃流数量 */
  get activeCount(): number {
    return this.controllers.size;
  }

  getController(sessionId: string): AbortController | undefined {
    return this.controllers.get(sessionId);
  }

  /** 抢占：同会话已有活跃流时 abort 之并等其退场（最多 5s） */
  async preemptExisting(sessionId: string, kind: string): Promise<void> {
    const existingController = this.controllers.get(sessionId);
    if (existingController === undefined) {
      return;
    }
    logger.warn({ sessionId }, `检测到已有活跃 ${kind} stream，先中断旧 stream`);
    existingController.abort();
    const existingStream = this.streams.get(sessionId);
    if (existingStream !== undefined) {
      await Promise.race([
        existingStream,
        new Promise<void>((resolve) => setTimeout(resolve, PREEMPT_WAIT_MS)),
      ]);
    }
  }

  register(sessionId: string, controller: AbortController, stream: Promise<void>): void {
    this.controllers.set(sessionId, controller);
    this.streams.set(sessionId, stream);
  }

  abort(sessionId: string): boolean {
    const controller = this.controllers.get(sessionId);
    if (controller === undefined) {
      return false;
    }
    this.controllers.delete(sessionId);
    controller.abort();
    return true;
  }

  abortAll(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
  }

  /** 条件移除：只有「还是当初登记的那一个」才删——防被抢占的旧流结束时误删新流登记 */
  removeControllerIfCurrent(sessionId: string, controller: AbortController): boolean {
    if (this.controllers.get(sessionId) === controller) {
      this.controllers.delete(sessionId);
      return true;
    }
    return false;
  }

  removeStreamIfCurrent(sessionId: string, stream: Promise<void>): boolean {
    if (this.streams.get(sessionId) === stream) {
      this.streams.delete(sessionId);
      return true;
    }
    return false;
  }

  /** 退出善后：全量中止后排水等流结束（默认 3s 兜底强制清空——退出不能被拖死） */
  async dispose(timeoutMs = 3000): Promise<void> {
    this.abortAll();

    const streams = Array.from(this.streams.values());
    if (streams.length === 0) {
      return;
    }

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

    this.controllers.clear();
    this.streams.clear();
  }
}
