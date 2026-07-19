// src/renderer/stores/chat-stream.store.ts
// 聊天流式消息状态（Zustand 5）
// 设计文档 §5.1 场景 3 AI 流式对话
//
// 职责：
// - 缓冲按 sessionId 累积的流式 chunk 文本
// - 跟踪每个 sessionId 的流式状态（streaming / completed / error）
// - 流结束或出错时保存最终文本与错误信息
//
// 注意：不直接订阅 window.api.chat.onStreamChunk，由组件层
// 在 useEffect 中调用 init() 启动订阅，避免 store 模块加载即订阅。

import { create } from 'zustand';

/** 单个会话的流式状态 */
export type ChatStreamStatus = 'streaming' | 'completed' | 'error';

/**
 * 聊天流式消息状态接口
 *
 * 按 sessionId 维度组织，支持同时跟踪多个会话的流式状态。
 * 组件通过 selector 选择性订阅单个 sessionId 的状态，避免其他 session 更新触发重渲染。
 */
export interface ChatStreamState {
  /** 当前活跃会话 ID（用于 UI 高亮，可与其他 session 同时流式） */
  activeSessionId: string | null;
  /** 按 sessionId 累积的流式文本（流结束时被 fullText 覆盖） */
  chunksBySession: Record<string, string>;
  /** 按 sessionId 跟踪的流式状态 */
  statusBySession: Record<string, ChatStreamStatus>;
  /** 按 sessionId 保存的错误消息（仅在 status=error 时有意义） */
  errorBySession: Record<string, string>;
  /** 设置活跃会话 ID */
  setActiveSession: (id: string | null) => void;
  /** 累加 chunk 到指定 session（同时将状态置为 streaming） */
  appendChunk: (sessionId: string, chunk: string) => void;
  /** 流正常结束：用 fullText 覆盖累积文本（避免 chunk 累积误差） */
  endStream: (sessionId: string, fullText: string) => void;
  /** 流出错：记录错误消息并将状态置为 error */
  errorStream: (sessionId: string, message: string) => void;
  /** 清理指定 session 的所有流式状态（chunks/status/error） */
  clearSession: (sessionId: string) => void;
}

/**
 * 聊天流式状态 store
 *
 * 流式更新频繁，未使用 subscribeWithSelector；组件使用 selector 订阅
 * 单个 sessionId 即可避免无关重渲染。
 *
 * noUncheckedIndexedAccess 下 Record<string, T> 访问返回 T | undefined，
 * 更新时使用 `?? ''` 兜底以安全累加 chunk。
 *
 * @example
 * // 只订阅指定 session 的累积文本
 * const text = useChatStreamStore((s) => s.chunksBySession[sessionId] ?? '');
 */
export const useChatStreamStore = create<ChatStreamState>()((set) => ({
  activeSessionId: null,
  chunksBySession: {},
  statusBySession: {},
  errorBySession: {},
  setActiveSession: (id) => set({ activeSessionId: id }),
  appendChunk: (sessionId, chunk) =>
    set((state) => ({
      chunksBySession: {
        ...state.chunksBySession,
        [sessionId]: (state.chunksBySession[sessionId] ?? '') + chunk,
      },
      statusBySession: {
        ...state.statusBySession,
        [sessionId]: 'streaming',
      },
    })),
  endStream: (sessionId, fullText) =>
    set((state) => ({
      chunksBySession: {
        ...state.chunksBySession,
        [sessionId]: fullText,
      },
      statusBySession: {
        ...state.statusBySession,
        [sessionId]: 'completed',
      },
    })),
  errorStream: (sessionId, message) =>
    set((state) => ({
      statusBySession: {
        ...state.statusBySession,
        [sessionId]: 'error',
      },
      errorBySession: {
        ...state.errorBySession,
        [sessionId]: message,
      },
    })),
  // 使用 delete 而非解构移除 key，避免 _xxx 未使用变量警告
  clearSession: (sessionId) =>
    set((state) => {
      const newChunks = { ...state.chunksBySession };
      delete newChunks[sessionId];
      const newStatus = { ...state.statusBySession };
      delete newStatus[sessionId];
      const newErr = { ...state.errorBySession };
      delete newErr[sessionId];
      return {
        chunksBySession: newChunks,
        statusBySession: newStatus,
        errorBySession: newErr,
      };
    }),
}));
