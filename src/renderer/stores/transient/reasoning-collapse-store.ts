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
