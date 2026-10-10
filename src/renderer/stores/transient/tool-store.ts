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
 * - ask：需要用户审批（触发 InlineApprovalCard 内联审批卡）
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
      return updated ? { callsBySession: newMap } : state;
    }),

  clearBySession: (sessionId) =>
    set((state) => {
      const newMap = new Map(state.callsBySession);
      newMap.delete(sessionId);
      return { callsBySession: newMap };
    }),
}));
