// packages/shared/src/schemas/agent-events.ts
// Agent 回合事件契约（TurnEvent）单一真源
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义一次 Agent 推理回合（turn）的标准事件流
// - 是"回合事件系统"的领域契约：AgentRuntime 产出、agent-service 与
//   Transcript 消费，渲染层经 IPC 订阅
// - 与 AI SDK 解耦：事件是领域形状，不依赖 UIMessageStreamPart
//
// 设计（对齐 qwen-code agent-events.ts）：
// - 事件命名用过去式/进行时语义（turn-start / text-delta / tool-call…）
// - 统一上下文：sessionId + turnId + timestamp（消费者无需回查生产者）
// - TurnEventMap 提供类型安全的 on/emit 映射
// - 纯类型文件：不依赖 zod / AI SDK / IPC，可被任意进程导入
//
// 回合生命周期：
//   turn-start → (text-delta | tool-call → tool-result)* → turn-end
//   任一步出错 → error（随后 turn-end reason='error'）
// ──────────────────────────────────────────────────────────────

/** 回合事件类型（字符串字面量，IPC 传输友好） */
export const TurnEventType = {
  TURN_START: 'turn-start',
  TEXT_DELTA: 'text-delta',
  TOOL_CALL: 'tool-call',
  TOOL_RESULT: 'tool-result',
  TURN_END: 'turn-end',
  ERROR: 'error',
} as const;

/** 回合事件类型 TypeScript 类型 */
export type TurnEventType = (typeof TurnEventType)[keyof typeof TurnEventType];

/**
 * 回合终止原因（对齐 qwen AgentTerminateMode 的收敛子集）
 *
 * - completed：正常完成（模型给出最终答案）
 * - aborted：用户中断
 * - max-steps：达到 maxSteps 上限（防止无限循环）
 * - error：异常结束（已另行推送 error 事件）
 */
export type TurnTerminateReason = 'completed' | 'aborted' | 'max-steps' | 'error';

/** 回合事件统一上下文（所有事件必带） */
export interface TurnEventContext {
  readonly sessionId: string;
  /** 回合唯一 id（AgentRuntime 生成，UUID） */
  readonly turnId: string;
  /** 事件时间戳（Unix 毫秒） */
  readonly timestamp: number;
}

/** 回合 token 使用量（AI SDK totalUsage 的领域投影） */
export interface TurnUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  /** KV cache 命中 token（DeepSeek KV cache 计费可见性） */
  readonly cacheReadTokens?: number;
  /** 思维链 token（reasoning 模型） */
  readonly reasoningTokens?: number;
}

/** turn-start：回合开始（模型已选定） */
export interface TurnStartEvent extends TurnEventContext {
  readonly type: typeof TurnEventType.TURN_START;
  /** 本次回合使用的模型 id */
  readonly modelId: string;
}

/** text-delta：流式文本增量（渲染层逐字展示） */
export interface TurnTextDeltaEvent extends TurnEventContext {
  readonly type: typeof TurnEventType.TEXT_DELTA;
  readonly text: string;
}

/** tool-call：模型发起工具调用（对应 AI SDK tool-call part） */
export interface TurnToolCallEvent extends TurnEventContext {
  readonly type: typeof TurnEventType.TOOL_CALL;
  /** 工具调用 id（与 tool-result 配对） */
  readonly toolCallId: string;
  readonly toolName: string;
  /** 工具入参（结构由工具 schema 决定） */
  readonly input: unknown;
}

/** tool-result：工具执行完成（成功或失败） */
export interface TurnToolResultEvent extends TurnEventContext {
  readonly type: typeof TurnEventType.TOOL_RESULT;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly success: boolean;
  /** 失败原因（success=false 时提供） */
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
  /** 工具执行耗时（毫秒） */
  readonly durationMs?: number;
}

/** turn-end：回合结束（含统计信息） */
export interface TurnEndEvent extends TurnEventContext {
  readonly type: typeof TurnEventType.TURN_END;
  readonly reason: TurnTerminateReason;
  /** token 使用量（reason='completed' 时提供） */
  readonly usage?: TurnUsage;
  /** 回合总耗时（毫秒，turn-start 到 turn-end） */
  readonly durationMs: number;
}

/** error：回合内异常（随后 turn-end reason='error'） */
export interface TurnErrorEvent extends TurnEventContext {
  readonly type: typeof TurnEventType.ERROR;
  /** 错误码（与 AppError.code 对齐） */
  readonly code: string;
  readonly message: string;
}

/** 回合事件判别联合 */
export type TurnEvent =
  | TurnStartEvent
  | TurnTextDeltaEvent
  | TurnToolCallEvent
  | TurnToolResultEvent
  | TurnEndEvent
  | TurnErrorEvent;

/** 事件类型 → payload 的类型安全映射（on/emit 用） */
export interface TurnEventMap {
  [TurnEventType.TURN_START]: TurnStartEvent;
  [TurnEventType.TEXT_DELTA]: TurnTextDeltaEvent;
  [TurnEventType.TOOL_CALL]: TurnToolCallEvent;
  [TurnEventType.TOOL_RESULT]: TurnToolResultEvent;
  [TurnEventType.TURN_END]: TurnEndEvent;
  [TurnEventType.ERROR]: TurnErrorEvent;
}
