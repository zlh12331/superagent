// src/renderer/stores/transient/reasoning-collapse-store.ts
// 消息推理块折叠态（L2 transient）
// ──────────────────────────────────────────────────────────────
// 背景：MessageItem 此前用本地 useState(!reasoningCollapsed)——
// 1) 虚拟列表滚动卸载消息后折叠态丢失；
// 2) settings.experimental.reasoningCollapsed 变化不响应已挂载消息。
//
// 设计：
// - 仅存用户显式覆盖（Map<collapseKey, boolean>）；未覆盖的块
//   实时跟随 settings 默认值（default 派生，不固化）
// - collapseKey 由调用方组合为 `${messageId}:${partIndex}`（part 级）——
//   一条消息可含多段思考（多步工具循环每 step 一段），key 粗到 messageId
//   会导致同消息所有思考块联动展开/折叠（历史 bug，2026-09-05 修复）
// - 会话切换不清理（key 含全局唯一消息 id，折叠态跟随消息生命周期）
// ──────────────────────────────────────────────────────────────

import { create } from 'zustand';

interface ReasoningCollapseState {
  /** 用户显式覆盖的折叠态（collapseKey → true=折叠；未覆盖 = 跟随 settings 默认） */
  readonly overrides: ReadonlyMap<string, boolean>;
  /** 设置某个思考块的折叠态覆盖（null = 清除覆盖，回到 settings 默认） */
  readonly setCollapsed: (collapseKey: string, collapsed: boolean | null) => void;
}

export const useReasoningCollapseStore = create<ReasoningCollapseState>()((set) => ({
  overrides: new Map(),
  setCollapsed: (collapseKey, collapsed) =>
    set((state) => {
      const next = new Map(state.overrides);
      if (collapsed === null) {
        next.delete(collapseKey);
      } else {
        next.set(collapseKey, collapsed);
      }
      return { overrides: next };
    }),
}));
