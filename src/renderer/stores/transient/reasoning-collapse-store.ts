// src/renderer/stores/transient/reasoning-collapse-store.ts
// 消息推理块折叠态（L2 transient）
// ──────────────────────────────────────────────────────────────
// 背景：MessageItem 此前用本地 useState(!reasoningCollapsed)——
// 1) 虚拟列表滚动卸载消息后折叠态丢失；
// 2) settings.experimental.reasoningCollapsed 变化不响应已挂载消息。
//
// 设计：
// - 仅存用户显式覆盖（Map<messageId, boolean>）；未覆盖的消息
//   实时跟随 settings 默认值（default 派生，不固化）
// - 会话切换不清理（消息 id 全局唯一，折叠态跟随消息生命周期）
// ──────────────────────────────────────────────────────────────

import { create } from 'zustand';

interface ReasoningCollapseState {
  /** 用户显式覆盖的折叠态（messageId → true=折叠；未覆盖 = 跟随 settings 默认） */
  readonly overrides: ReadonlyMap<string, boolean>;
  /** 设置某条消息的折叠态覆盖（null = 清除覆盖，回到 settings 默认） */
  readonly setCollapsed: (messageId: string, collapsed: boolean | null) => void;
}

export const useReasoningCollapseStore = create<ReasoningCollapseState>()((set) => ({
  overrides: new Map(),
  setCollapsed: (messageId, collapsed) =>
    set((state) => {
      const next = new Map(state.overrides);
      if (collapsed === null) {
        next.delete(messageId);
      } else {
        next.set(messageId, collapsed);
      }
      return { overrides: next };
    }),
}));
