/** 收集的 IPC 事件 */
export interface SentEvent {
  readonly channel: string;
  readonly payload: unknown;
}

/**
 * 创建 fake WebContents。
 *
 * @returns wc 传给 handler ctx.sender；sent 收集全部推送事件
 */
export function createFakeWebContents(): {
  wc: never;
  sent: SentEvent[];
  /** 模拟窗口销毁：触发并清空全部 once('destroyed') 监听 */
  emitDestroyed: () => void;
} {
  const sent: SentEvent[] = [];
  const destroyedListeners = new Set<(...args: unknown[]) => void>();
  const wc = {
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload });
    },
    isDestroyed: () => false,
    once: (channel: string, listener: (...args: unknown[]) => void) => {
      if (channel === 'destroyed') {
        destroyedListeners.add(listener);
      }
      return wc;
    },
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
      if (channel === 'destroyed') {
        destroyedListeners.delete(listener);
      }
      return wc;
    },
  } as never;
  return {
    wc,
    sent,
    emitDestroyed: () => {
      for (const listener of [...destroyedListeners]) {
        listener();
      }
      destroyedListeners.clear();
    },
  };
}
