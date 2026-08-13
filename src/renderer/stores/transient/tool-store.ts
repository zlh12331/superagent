// src/renderer/stores/transient/tool-store.ts
// 工具调用状态管理（L4 流式推送状态层 - transient）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 维护工具调用队列（按 sessionId 分组，主进程推送 tool:call / tool:result 事件时更新）
// - 提供 appendToolCall / appendToolResult / clearBySession 原子操作
// - 单个会话可有多个工具调用（Agent 一次对话可能连续调用多个工具）
//
// 设计：
// - 纯状态容器，不调用 IPC（业务 hook 监听 IPC 事件后调用 store 方法）
// - toolCall 与 toolResult 通过 toolCallId 配对（主进程保证配对推送）
// - 按 sessionId 分组：切换会话时仅展示当前会话的工具调用
// - 不持久化：工具调用历史是运行时态，跨重启保留意义不大
//   （持久化的会话历史中已包含 tool 调用，可通过 session:get 恢复）
//
// 状态机：
// - pending：收到 tool:call，等待 tool:result
// - success：收到 tool:result，无 error
// - error：收到 tool:result，含 error
// ──────────────────────────────────────────────────────────────

import { create } from 'zustand';

/**
 * 工具调用状态
 *
 * - pending：已收到工具调用请求，等待结果
 * - success：工具执行成功
 * - error：工具执行失败（含错误信息）
 */
export type ToolCallStatus = 'pending' | 'success' | 'error';

/**
 * 工具调用权限级别
 *
 * - auto：自动执行（无需用户审批）
 * - ask：需要用户审批（会触发 ApprovalDialog）
 * - deny：被拒绝（plan/审批模式约束，工具卡片直接展示拒绝态）
 */
export type ToolPermission = 'auto' | 'ask' | 'deny';

/**
 * 工具调用错误信息
 */
export interface ToolCallError {
  /** 错误码（如 TOOL_NOT_FOUND / TOOL_PERMISSION_DENIED / TOOL_EXECUTION_FAILED / TOOL_ABORTED） */
  readonly code: string;
  /** 人类可读错误消息 */
  readonly message: string;
}

/**
 * 工具调用项
 *
 * 完整记录一次工具调用的生命周期：
 * 1. 主进程推送 tool:call → 创建 pending 项
 * 2. 主进程推送 tool:result → 更新为 success / error
 */
export interface ToolCallItem {
  /** 工具调用唯一 id（AI SDK 生成，与 tool:result 配对） */
  readonly id: string;
  /** 所属会话 id */
  readonly sessionId: string;
  /** 工具名称（如 read_file / write_file / run_command） */
  readonly toolName: string;
  /** 人类可读标题（UI 展示用，如 "读取文件: src/main.ts"；pending 时为 null） */
  readonly title: string | null;
  /** 工具入参（结构由工具 schema 决定，渲染层不校验） */
  readonly input: unknown;
  /** 权限级别 */
  readonly permission: ToolPermission;
  /** 当前状态 */
  readonly status: ToolCallStatus;
  /** 工具输出（结构由工具决定，status='success' 时有值） */
  readonly output: unknown;
  /** 错误信息（status='error' 时有值） */
  readonly error: ToolCallError | null;
  /** 创建时间戳（ms，收到 tool:call 时） */
  readonly createdAt: number;
  /** 完成时间戳（ms，收到 tool:result 时，pending 时为 null） */
  readonly resolvedAt: number | null;
}

/**
 * 每会话工具调用保留上限（P3 修复：回合结束不再清空——右面板数据源，
 * 改为环形淘汰最旧项，兼顾可回看与内存上限）
 */
const MAX_CALLS_PER_SESSION = 500;

/**
 * 工具状态形状
 */
interface ToolState {
  /** 工具调用列表（按 sessionId 分组的 Map，value 为该会话的工具调用数组） */
  readonly callsBySession: ReadonlyMap<string, readonly ToolCallItem[]>;

  // ── 操作方法 ────────────────────────────────────────
  /** 入队工具调用（主进程推送 tool:call 时调用） */
  readonly appendToolCall: (
    item: Omit<ToolCallItem, 'status' | 'output' | 'error' | 'title' | 'createdAt' | 'resolvedAt'>,
  ) => void;
  /** 更新工具结果（主进程推送 tool:result 时调用） */
  readonly appendToolResult: (
    toolCallId: string,
    result: {
      readonly output: unknown;
      readonly error: ToolCallError | null;
      readonly title?: string;
    },
  ) => void;
  /** 清空指定会话的所有工具调用（会话切换或关闭时调用） */
  readonly clearBySession: (sessionId: string) => void;
}

/**
 * 工具状态 store
 *
 * 使用 Map<sessionId, ToolCallItem[]> 按 sessionId 分组存储。
 * 渲染层通过 sessionId 查询当前会话的工具调用列表。
 *
 * @example
 * ```tsx
 * const calls = useToolStore((s) => s.callsBySession.get(sessionId) ?? []);
 * const appendToolCall = useToolStore((s) => s.appendToolCall);
 * ```
 */
export const useToolStore = create<ToolState>()((set) => ({
  callsBySession: new Map<string, readonly ToolCallItem[]>(),

  appendToolCall: (item) =>
    set((state) => {
      const newMap = new Map(state.callsBySession);
      const existing = newMap.get(item.sessionId) ?? [];
      const newItem: ToolCallItem = {
        ...item,
        status: 'pending',
        title: null,
        output: null,
        error: null,
        createdAt: Date.now(),
        resolvedAt: null,
      };
      // P3 修复：每会话环形淘汰（保留最近 MAX_CALLS_PER_SESSION 条），
      // 回合结束不再清空后仍需防止长会话内存无限增长
      const next = [...existing, newItem];
      const trimmed =
        next.length > MAX_CALLS_PER_SESSION
          ? next.slice(next.length - MAX_CALLS_PER_SESSION)
          : next;
      newMap.set(item.sessionId, trimmed);
      return { callsBySession: newMap };
    }),

  appendToolResult: (toolCallId, result) =>
    set((state) => {
      const newMap = new Map<string, readonly ToolCallItem[]>();
      let updated = false;
      // 遍历所有会话，找到对应 toolCallId 并更新
      for (const [sessionId, calls] of state.callsBySession) {
        const updatedCalls = calls.map((call) => {
          if (call.id !== toolCallId) {
            return call;
          }
          updated = true;
          return {
            ...call,
            status: (result.error !== null ? 'error' : 'success') as ToolCallStatus,
            title: result.title ?? call.title,
            output: result.output,
            error: result.error,
            resolvedAt: Date.now(),
          };
        });
        newMap.set(sessionId, updatedCalls);
      }
      // 若未找到匹配的 toolCallId（不应发生），返回原 state
      return updated ? { callsBySession: newMap } : state;
    }),

  clearBySession: (sessionId) =>
    set((state) => {
      const newMap = new Map(state.callsBySession);
      newMap.delete(sessionId);
      return { callsBySession: newMap };
    }),
}));
