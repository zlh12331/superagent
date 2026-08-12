// tests/integration/helpers/fake-webcontents.ts
// 集成测试共享基建：fake WebContents（IPC 推送目标替身）
// ──────────────────────────────────────────────────────────────
// Electron SDK 边界替身：send 收集事件供断言；isDestroyed 恒定 false。
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
export function createFakeWebContents(): { wc: never; sent: SentEvent[] } {
  const sent: SentEvent[] = [];
  const wc = {
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload });
    },
    isDestroyed: () => false,
  } as never;
  return { wc, sent };
}
