import { create } from 'zustand';

import { type PendingMessageRecord, resolvePendingMessage } from '@/lib/pending-message';

/** 首条消息暂存状态形状 */
interface PendingMessageState {
  /** sessionId → 暂存记录（仅消费方读取，不订阅：避免 set 引发额外渲染） */
  readonly records: Readonly<Record<string, PendingMessageRecord>>;
  /** 暂存首条消息（同 sessionId 覆盖写入） */
  readonly stash: (sessionId: string, text: string) => void;
  /**
   * 消费首条消息：先删后判，因此「恰好一次」由状态机保证
   * @returns 可自动发送的文本；未暂存 / 空文本 / 已过期返回 null
   */
  readonly consume: (sessionId: string) => string | null;
}

export const usePendingMessageStore = create<PendingMessageState>()((set, get) => ({
  records: {},

  stash: (sessionId, text) =>
    set((state) => ({
      records: { ...state.records, [sessionId]: { text, createdAt: Date.now() } },
    })),

  consume: (sessionId) => {
    const text = resolvePendingMessage(get().records[sessionId]);
    if (sessionId in get().records) {
      set((state) => {
        const rest: Record<string, PendingMessageRecord> = { ...state.records };
        delete rest[sessionId];
        return { records: rest };
      });
    }
    return text;
  },
}));
