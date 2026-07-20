// src/renderer/stores/agent-stream.store.ts
// Agent 写作流式状态（Zustand 5）
// 设计文档 §5.1 场景 5（Agent 章节生成）+ §5.5 流式响应中断设计
//
// 职责：
// - 按 ackId 维度缓冲 Agent 流式 chunk 文本（与 chat-stream.store 独立，避免污染对话状态）
// - 跟踪每个 ackId 的流式状态（streaming / completed / error）
// - 流结束或出错时保存最终文本与错误信息
// - 记录每个 ackId 的"任务类型"（generate / rewrite / expand），用于 UI 区分展示
//
// 设计决策（与 chat-stream.store 保持独立的理由）：
// - 语义不同：本 store 按 ackId 索引（任务级），含 kind/targetId 元信息用于完成后失效缓存
//   chat-stream 按 sessionId 索引（会话级），含 activeSessionId 用于 UI 高亮
// - 合并后需用 union 类型区分 chat session 与 agent task，反而增加复杂度
// - 两个 store 各自独立测试与维护，符合"高内聚低耦合"
// - 现有 5 个组件/hook 已稳定，物理合并风险高、收益低
//
// 注意：
// - Agent 后端复用 chat:stream:chunk/end/error channel，但 payload.sessionId 实际是 ackId
//   （见 src/main/services/agent.service.ts 的 streamId: ackId）
// - 故前端订阅时需按 ackId 过滤，写入本 store
// - 不直接订阅 window.api，由组件层在 useEffect 中调用订阅 hook 启动订阅

import { create } from 'zustand';

/** Agent 任务类型 */
export type AgentTaskKind = 'generate' | 'rewrite' | 'expand';

/** 单个 ackId 的流式状态 */
export type AgentStreamStatus = 'streaming' | 'completed' | 'error';

/**
 * Agent 流式状态接口
 *
 * 按 ackId 维度组织，支持同时跟踪多个 Agent 任务的流式状态。
 * 组件通过 selector 选择性订阅单个 ackId 的状态，避免无关更新触发重渲染。
 */
export interface AgentStreamState {
  /** 按 ackId 累积的流式文本（流结束时被 fullText 覆盖） */
  chunksByAckId: Record<string, string>;
  /** 按 ackId 跟踪的流式状态 */
  statusByAckId: Record<string, AgentStreamStatus>;
  /** 按 ackId 保存的错误消息（仅在 status=error 时有意义） */
  errorByAckId: Record<string, string>;
  /** 按 ackId 记录的任务类型（UI 展示用，如 "AI 续写" / "AI 改写" / "AI 扩写"） */
  kindByAckId: Record<string, AgentTaskKind>;
  /** 按 ackId 记录的目标 ID（chapterId / projectId，用于完成后失效缓存） */
  targetIdByAckId: Record<string, string>;
  /**
   * 注册一个 Agent 任务（在 mutation 调用成功返回 ackId 后立即调用）
   *
   * @param ackId - 流 ID
   * @param kind - 任务类型
   * @param targetId - 目标资源 ID（generate=projectId / rewrite=chapterId / expand=projectId）
   */
  registerStream: (ackId: string, kind: AgentTaskKind, targetId: string) => void;
  /** 累加 chunk 到指定 ackId（同时将状态置为 streaming） */
  appendChunk: (ackId: string, chunk: string) => void;
  /** 流正常结束：用 fullText 覆盖累积文本（避免 chunk 累积误差） */
  endStream: (ackId: string, fullText: string) => void;
  /** 流出错：记录错误消息并将状态置为 error */
  errorStream: (ackId: string, message: string) => void;
  /** 清理指定 ackId 的所有流式状态 */
  clearStream: (ackId: string) => void;
}

/**
 * Agent 流式状态 store
 *
 * 流式更新频繁，未使用 subscribeWithSelector；组件使用 selector 订阅
 * 单个 ackId 即可避免无关重渲染。
 *
 * noUncheckedIndexedAccess 下 Record<string, T> 访问返回 T | undefined，
 * 更新时使用 `?? ''` 兜底以安全累加 chunk。
 *
 * @example
 * // 只订阅指定 ackId 的累积文本
 * const text = useAgentStreamStore((s) => s.chunksByAckId[ackId] ?? '');
 */
export const useAgentStreamStore = create<AgentStreamState>()((set) => ({
  chunksByAckId: {},
  statusByAckId: {},
  errorByAckId: {},
  kindByAckId: {},
  targetIdByAckId: {},
  registerStream: (ackId, kind, targetId) =>
    set((state) => ({
      kindByAckId: { ...state.kindByAckId, [ackId]: kind },
      targetIdByAckId: { ...state.targetIdByAckId, [ackId]: targetId },
      statusByAckId: { ...state.statusByAckId, [ackId]: 'streaming' },
      chunksByAckId: { ...state.chunksByAckId, [ackId]: '' },
    })),
  appendChunk: (ackId, chunk) =>
    set((state) => ({
      chunksByAckId: {
        ...state.chunksByAckId,
        [ackId]: (state.chunksByAckId[ackId] ?? '') + chunk,
      },
      statusByAckId: {
        ...state.statusByAckId,
        [ackId]: 'streaming',
      },
    })),
  endStream: (ackId, fullText) =>
    set((state) => ({
      chunksByAckId: {
        ...state.chunksByAckId,
        [ackId]: fullText,
      },
      statusByAckId: {
        ...state.statusByAckId,
        [ackId]: 'completed',
      },
    })),
  errorStream: (ackId, message) =>
    set((state) => ({
      statusByAckId: {
        ...state.statusByAckId,
        [ackId]: 'error',
      },
      errorByAckId: {
        ...state.errorByAckId,
        [ackId]: message,
      },
    })),
  // 使用 delete 而非解构移除 key，避免 _xxx 未使用变量警告
  clearStream: (ackId) =>
    set((state) => {
      const newChunks = { ...state.chunksByAckId };
      delete newChunks[ackId];
      const newStatus = { ...state.statusByAckId };
      delete newStatus[ackId];
      const newErr = { ...state.errorByAckId };
      delete newErr[ackId];
      const newKind = { ...state.kindByAckId };
      delete newKind[ackId];
      const newTarget = { ...state.targetIdByAckId };
      delete newTarget[ackId];
      return {
        chunksByAckId: newChunks,
        statusByAckId: newStatus,
        errorByAckId: newErr,
        kindByAckId: newKind,
        targetIdByAckId: newTarget,
      };
    }),
}));
