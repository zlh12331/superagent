// agent-events.ts：Agent 回合事件契约单一真源——回合事件流的形状 + 按事件类型收窄 payload 的订阅/发射映射
// 零 import，不依赖 zod / AI SDK：事件是领域形状，不绑 SDK 的 UIMessageStreamPart。
// 生命周期：turn-start → (text-delta | tool-call → tool-result)* → turn-end；任一步出错
// → error（随后 turn-end reason='error'）。运行时消费方全在主进程（通知 / IM / 远程 / 子代理 / 记忆 / 目标判定）。
// ────────── 值域与基座：事件类型 / 终止原因 / 统一上下文 / 用量 ──────────
/**
 * 回合事件类型值域（对象 + 同名联合类型的双重形态）
 *
 * 需要对象而非裸类型：订阅与事件构造按名取值（`TurnEventType.TEXT_DELTA`）；
 * 值同时充当事件对象的 `type` 判别键与 TurnEventMap 的键集，联合类型从本对象
 * 派生，增删事件时值与类型不会漂移。
 */
export const TurnEventType = {
  TURN_START: 'turn-start',
  TEXT_DELTA: 'text-delta',
  TOOL_CALL: 'tool-call',
  TOOL_RESULT: 'tool-result',
  TURN_END: 'turn-end',
  ERROR: 'error',
} as const;

/** 回合事件类型字面量联合（由上方同名 const 派生：'turn-start' | … | 'error'） */
export type TurnEventType = (typeof TurnEventType)[keyof typeof TurnEventType];

/**
 * 回合终止原因（对齐 qwen-code 终止语义的收敛子集；四个取值同时是 turns.status 的取值域，
 * 见 src/main/infra/storage/schema.ts 的 TurnStatus）
 *
 * - completed：正常完成（模型给出最终答案）
 * - aborted：用户中断
 * - max-steps：达到 maxSteps 步数上限（防无限循环）
 * - error：异常结束（error 事件先行推送，随后 turn-end 带本值）
 *
 * 改名须连带数据迁移：turns.status 是应用层枚举（无 DB CHECK），改字面量不会被约束拦下，
 * 只会让存量行静默失配。
 *
 * 注意 max-steps 当前无产出方：回合内的 maxSteps 由 AI SDK 的 stopWhen 停流，回合仍以
 * completed 收尾。
 */
export type TurnTerminateReason = 'completed' | 'aborted' | 'max-steps' | 'error';

/**
 * 回合事件统一上下文（六个事件全部继承；消费方无需回查生产者即可把事件归位到会话与回合）
 */
export interface TurnEventContext {
  /** 所属会话 id（类级订阅方按它过滤或分桶事件） */
  readonly sessionId: string;
  /** 回合唯一 id（UUID，每回合新生成；同回合的事件、消息与 turns 行共用同一值） */
  readonly turnId: string;
  /** 事件时间戳（Unix 毫秒） */
  readonly timestamp: number;
}

/**
 * 回合 token 使用量（AI SDK totalUsage 的领域投影）
 *
 * 可选字段的语义是「未提供」而非 0（投影层不补零）：cacheReadTokens / reasoningTokens
 * 缺省表示上游未给该维度，而不是「没有缓存命中 / 没有思维链」。
 */
export interface TurnUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  /** KV cache 命中 token（DeepSeek 系计费可见性；源为 SDK inputTokenDetails.cacheReadTokens） */
  readonly cacheReadTokens?: number;
  /** 思维链 token（reasoning 模型；源为 SDK outputTokenDetails.reasoningTokens） */
  readonly reasoningTokens?: number;
}

// ────────── 六个回合事件：共享 TurnEventContext 基座，type 字面量即判别键 ──────────
/**
 * turn-start：回合开始（模型已选定；每回合的首个事件）
 *
 * 消费方用它标定回合边界（重置回合级累积缓冲）。
 */
export interface TurnStartEvent extends TurnEventContext {
  readonly type: typeof TurnEventType.TURN_START;
  /** 本次回合使用的模型 id（落库为 turns.model_id） */
  readonly modelId: string;
}

/**
 * text-delta：模型输出的流式文本增量（按流序到达，逐 part 一个事件）
 *
 * 依序累积拼接即该回合的助手全文（agent-service 与记忆捕获等订阅方都如此消费）。
 */
export interface TurnTextDeltaEvent extends TurnEventContext {
  readonly type: typeof TurnEventType.TEXT_DELTA;
  readonly text: string;
}

/** tool-call：模型发起工具调用（AI SDK tool-call part 的领域投影） */
export interface TurnToolCallEvent extends TurnEventContext {
  readonly type: typeof TurnEventType.TOOL_CALL;
  /** 工具调用 id（与 tool-result 配对；沿用 SDK 的 toolCallId） */
  readonly toolCallId: string;
  readonly toolName: string;
  /** 工具入参（结构由各工具自己的 schema 决定，本契约为 unknown） */
  readonly input: unknown;
}

/**
 * tool-result：工具执行完成（成功与失败共用；与 tool-call 以 toolCallId 配对）
 *
 * 失败也走本事件而非 error：错误交回模型自行决定重试/换工具/告知用户
 * （回合级 error 事件留给不可恢复的流与编排异常）。
 */
export interface TurnToolResultEvent extends TurnEventContext {
  readonly type: typeof TurnEventType.TOOL_RESULT;
  readonly toolCallId: string;
  readonly toolName: string;
  /** 执行是否成功（失败时 error 提供原因与错误码） */
  readonly success: boolean;
  /** 失败原因（success=false 时提供） */
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
  /** 工具执行耗时（毫秒；success=true 时提供，与 error 互斥） */
  readonly durationMs?: number;
}

/**
 * turn-end：回合结束（含统计信息；每回合恰好一次，是消费方收尾与落库的触发点）
 */
export interface TurnEndEvent extends TurnEventContext {
  readonly type: typeof TurnEventType.TURN_END;
  /** 终止原因（落库为 turns.status；通知与各回传按它分组） */
  readonly reason: TurnTerminateReason;
  /** token 使用量（仅 reason='completed' 提供；中断与错误回合无统计） */
  readonly usage?: TurnUsage;
  /** 回合总耗时（毫秒，turn-start 到 turn-end） */
  readonly durationMs: number;
}

/** error：回合内异常（先于 turn-end(reason='error') 推送） */
export interface TurnErrorEvent extends TurnEventContext {
  readonly type: typeof TurnEventType.ERROR;
  /** 错误码（与 AppError.code 对齐；同回合的 agent:stream:error 推送同码同消息） */
  readonly code: string;
  /** 错误消息（人类可读原文，供展示与回传） */
  readonly message: string;
}

// ────────── 消费侧：判别联合 + 类型安全的 on/emit 映射 ──────────
/** 回合事件判别联合（按 type 字面量收窄；与 TurnEventMap 一一对应） */
export type TurnEvent =
  | TurnStartEvent
  | TurnTextDeltaEvent
  | TurnToolCallEvent
  | TurnToolResultEvent
  | TurnEndEvent
  | TurnErrorEvent;

/**
 * 事件类型 → payload 的类型安全映射（on/emit 用）
 *
 * TurnEventEmitter.on(type, listener) 借此把 listener 形参收窄为对应事件类型；
 * 键取自 TurnEventType 的取值，成员须与上方联合逐项对齐。
 */
export interface TurnEventMap {
  [TurnEventType.TURN_START]: TurnStartEvent;
  [TurnEventType.TEXT_DELTA]: TurnTextDeltaEvent;
  [TurnEventType.TOOL_CALL]: TurnToolCallEvent;
  [TurnEventType.TOOL_RESULT]: TurnToolResultEvent;
  [TurnEventType.TURN_END]: TurnEndEvent;
  [TurnEventType.ERROR]: TurnErrorEvent;
}
