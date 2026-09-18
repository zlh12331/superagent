// src/renderer/stores/transient/update-store.ts
// 更新状态（L2 transient：单订阅写入，多消费点读取）
// ──────────────────────────────────────────────────────────────
// 背景：此前 AboutSection / UpdateNotice / UpdateIndicator 各自 useUpdate() 订阅
// update:event:status —— 同一事件通道被订阅 3 次（每个订阅各发一次 getStatus +
// 一次 subscribeStatus，dev 下 StrictMode 再翻倍），与项目"单 bridge 挂 AppShell
// + 写 store"的既有惯例（use-agent-bridge / use-tool-bridge 等 5 个）不符。
// 现在订阅只发生在 use-update-bridge，本 store 是唯一状态载体。
// ──────────────────────────────────────────────────────────────

import type { UpdateStatusPayload } from '@code-agent/shared/renderer';
import { create } from 'zustand';

/** 更新状态 store 接口 */
interface UpdateStoreState {
  /** 最新状态（事件推送或挂载快照） */
  readonly status: UpdateStatusPayload | null;
  /** 当前状态是否仅来自挂载快照（回放，不应触发提示类副作用） */
  readonly fromSnapshot: boolean;
  /** 上次检查发起时间（毫秒时间戳；本次会话与快照均无记录时 null） */
  readonly lastCheckAt: number | null;
  /** bridge 写入挂载快照（读语义：不触发提示） */
  readonly applySnapshot: (snapshot: UpdateStatusPayload, lastCheckAt: number | null) => void;
  /** bridge 写入事件推送（实时状态，可触发提示） */
  readonly applyLive: (payload: UpdateStatusPayload) => void;
  /** 记上次检查时间（手动检查后本地刷新，避免再发一次 getStatus） */
  readonly markChecked: (at: number) => void;
}

export const useUpdateStore = create<UpdateStoreState>()((set) => ({
  status: null,
  fromSnapshot: false,
  lastCheckAt: null,
  applySnapshot: (snapshot, lastCheckAt) =>
    set((prev) => ({
      status: snapshot,
      fromSnapshot: true,
      lastCheckAt: lastCheckAt ?? prev.lastCheckAt,
    })),
  applyLive: (payload) => set({ status: payload, fromSnapshot: false }),
  markChecked: (at) => set({ lastCheckAt: at }),
}));
