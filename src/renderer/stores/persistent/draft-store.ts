// src/renderer/stores/persistent/draft-store.ts
// 输入草稿持久化（L2 persistent）——对齐参考项目 useDraftStore
// ──────────────────────────────────────────────────────────────
// 背景：切换会话/重启后输入草稿丢失——用户在 A 会话输入到一半切到 B，
// 回来时内容清空（同类软件均保留草稿）。
//
// 设计：
// - key：chatId → { text, attachments }（附件为路径列表，可跨重启恢复）
// - persist 到 localStorage（zustand persist v3 协议）
// - 发送成功后由 ChatInput 调用 clearDraft（草稿只保留未发送内容）
// ──────────────────────────────────────────────────────────────

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/** 单会话草稿 */
export interface ChatDraft {
  /** 输入文本 */
  readonly text: string;
  /** 附件文件路径列表 */
  readonly attachments: readonly string[];
}

interface DraftState {
  /** chatId → 草稿 */
  readonly drafts: Readonly<Record<string, ChatDraft>>;
  /** 读取草稿（无则返回空草稿） */
  getDraft: (chatId: string) => ChatDraft;
  /** 保存草稿（空文本时仍保存，便于覆盖旧值） */
  setDraft: (chatId: string, draft: ChatDraft) => void;
  /** 清除草稿（发送成功后调用） */
  clearDraft: (chatId: string) => void;
}

/** 空草稿常量（避免每次 getDraft 新建引用） */
const EMPTY_DRAFT: ChatDraft = { text: '', attachments: [] };

export const useDraftStore = create<DraftState>()(
  persist(
    (set, get) => ({
      drafts: {},

      getDraft: (chatId: string): ChatDraft => get().drafts[chatId] ?? EMPTY_DRAFT,

      setDraft: (chatId: string, draft: ChatDraft) =>
        set((state) => ({
          drafts: { ...state.drafts, [chatId]: draft },
        })),

      clearDraft: (chatId: string) =>
        set((state) => {
          const next = { ...state.drafts };
          delete next[chatId];
          return { drafts: next };
        }),
    }),
    {
      name: 'code-agent:drafts',
      storage: createJSONStorage(() => localStorage),
      // 版本化：结构变更时通过 migrate 兼容（当前 v1 无迁移）
      version: 1,
    },
  ),
);
