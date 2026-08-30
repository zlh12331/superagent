// src/renderer/stores/transient/pending-message-store.ts
// 欢迎页首条消息暂存（L2 客户端共享状态层 - transient）
// ──────────────────────────────────────────────────────────────
// 职责：home.tsx 创建会话成功后暂存首条消息，ChatPanel 挂载后 consume 一次并自动发送。
//
// 为什么不用 sessionStorage（此前实现）：
// - 手写字段名 + JSON 编解码 + 时间戳字符串化，契约散落在写入/读取两端，无类型约束
// - 读取端要自己负责 removeItem，异常路径（解析失败/挂载前取消）易残留坏数据
// - Electron 的 sessionStorage 本就不跨应用重启持久化，用「浏览器存储」换来的只是
//   一层隐式耦合；跨重启行为（重启后不自动发送）在内存 store 下完全一致
//
// 为什么不塞进 welcome-store：
// - 创建会话同一路由跳转内会调用 exitWelcomeMode()，welcome store 的预设目录会被清空，
//   消息若挂在同一 state 上会被连带清掉（生命周期不同，必须分离）
//
// 不持久化：进程退出即散（跨重启不自动发送是既定行为）。
// ──────────────────────────────────────────────────────────────

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
