// tests/integration/helpers/fake-webcontents.ts
// 集成测试共享基建：fake WebContents（IPC 推送目标替身）
// ──────────────────────────────────────────────────────────────
// Electron SDK 边界替身：send 收集事件供断言；isDestroyed 恒定 false；
// once 支持 'destroyed' 清理回调注册（FileService watcher / TerminalService PTY
// 均在推送目标上注册 once('destroyed')——缺该方法会让集成链路在 create/watchStart
// 处 TypeError，与真实 Electron API 不对齐）。
// 对应用例：const { wc, sent } = createFakeWebContents();
// ──────────────────────────────────────────────────────────────

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
    // 与 Electron 签名对齐：返回 this 支持链式
    once: (channel: string, listener: (...args: unknown[]) => void) => {
      if (channel === 'destroyed') {
        destroyedListeners.add(listener);
      }
      return wc;
    },
    // FileService.unwatch / TerminalService PTY 退出会移除 destroyed 监听
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
