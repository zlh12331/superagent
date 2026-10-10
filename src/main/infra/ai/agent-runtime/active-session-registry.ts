import { logger } from '../../../utils/logger';

const PREEMPT_WAIT_MS = 5000;

export class ActiveSessionRegistry {
  private readonly controllers = new Map<string, AbortController>();
  private readonly streams = new Map<string, Promise<void>>();

  get activeCount(): number {
    return this.controllers.size;
  }

  getController(sessionId: string): AbortController | undefined {
    return this.controllers.get(sessionId);
  }

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
