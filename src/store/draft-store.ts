import { create, type StateCreator } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Draft Store — 输入框草稿
 *
 * 状态管理决策树位置：
 *   persist middleware（草稿需要跨会话持久化）
 *
 * 用户在对话输入框中输入的内容会自动保存，
 * 即使关闭应用再打开，草稿依然保留。
 * 每个 thread 有独立的草稿。
 *
 * @see src/features/conversation/ — 输入框组件
 */

export interface DraftState {
  /** threadId → 草稿文本（按会话隔离，每个 thread 拥有独立草稿） */
  drafts: Record<string, string>

  /**
   * 设置指定 thread 的草稿文本。
   * 输入框 onChange 时实时调用，由 persist 中间件异步持久化到 Tauri Store。
   */
  setDraft: (threadId: string, text: string) => void
  /**
   * 获取指定 thread 的草稿（不存在时返回空字符串）。
   * 使用 get() 非响应式读取，适用于输入框初始化等一次性场景。
   */
  getDraft: (threadId: string) => string
  /**
   * 清除指定 thread 的草稿（用户主动发送消息后调用）。
   * 使用不可变重建避免 delete 操作，保证引用变更最小化。
   */
  clearDraft: (threadId: string) => void
  /**
   * 清除所有草稿（登出、清理数据等场景调用）。
   */
  clearAllDrafts: () => void
}

/**
 * store 实现：使用 persist 中间件持久化 drafts 字段。
 * 不引入 devtools（草稿变更频繁，devtools 日志会迅速膨胀）。
 */
const draftStoreCreator: StateCreator<DraftState> = (set, get) => ({
  drafts: {},

  setDraft: (threadId, text) =>
    set((state: DraftState) => ({
      drafts: { ...state.drafts, [threadId]: text },
    })),

  getDraft: threadId => get().drafts[threadId] ?? '',

  clearDraft: threadId =>
    set((state: DraftState) => ({
      drafts: Object.fromEntries(
        Object.entries(state.drafts).filter(([key]) => key !== threadId)
      ),
    })),

  clearAllDrafts: () => set({ drafts: {} }),
})

/**
 * 全局草稿 store 单例。
 *
 * 持久化策略：
 *  - name: 'codex-draft-store'，对应 Tauri Store 中的 key
 *  - partialize: 仅持久化 drafts 字段，方法不参与序列化（避免反序列化后丢失原型）
 *
 * 使用方式：
 *  - React 组件：`const text = useDraftStore(s => s.drafts[threadId])`
 *  - 非 React 模块：`useDraftStore.getState().setDraft(threadId, text)`
 *
 * @see src/features/conversation/MessageInput.tsx — 输入框组件，调用 setDraft/getDraft
 */
export const useDraftStore = create<DraftState>()(
  persist(draftStoreCreator, {
    name: 'codex-draft-store',
    // 仅持久化 drafts 字段，不包含方法
    partialize: state => ({ drafts: state.drafts }),
  })
)
