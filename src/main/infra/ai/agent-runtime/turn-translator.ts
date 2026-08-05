// src/main/infra/ai/agent-runtime/turn-translator.ts
// AI SDK part → TurnEvent 翻译器（纯函数）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 把 AI SDK 的 UIMessageStreamPart 翻译为领域事件 TurnEvent
// - 是"回合显式化"的翻译层：agent-service 读流时调用，SDK 形状不出模块
//
// 翻译范围（单一信息源原则）：
// - text-delta → TurnTextDeltaEvent（流侧信息完整）
// - tool-call  → TurnToolCallEvent（流侧信息完整）
// - tool-result 不在此翻译：其完整信息（耗时/错误详情）在 ToolExecutor
//   执行侧最全，由 agent-service 的 executeHook 直接 emit
// - 其余 part（step-start/finish/error 等）由回合层（agent-service）处理
// ──────────────────────────────────────────────────────────────

import type { TurnEvent, TurnEventContext, TurnEventType } from '@code-agent/shared/main';
import { TurnEventType as TurnEventTypeConst } from '@code-agent/shared/main';

/**
 * AI SDK 流式 part 的领域投影
 *
 * 只声明翻译需要的字段（text-delta / tool-call），与 SDK 精确导出解耦：
 * - 不依赖 UIMessageStreamPart 等 SDK 内部类型名（各版本导出位置不同）
 * - SDK part 形状变化时仅需同步本投影 + 运行时守卫，编译错误提示明确
 */
export interface StreamPart {
  readonly type: string;
  readonly delta?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly args?: unknown;
}

/**
 * 翻译单个流 part 为回合事件
 *
 * @param part AI SDK 流式 part（toUIMessageStream 的 read 产物）
 * @param ctx 回合上下文（sessionId / turnId / timestamp）
 * @returns 对应 TurnEvent；不可翻译或字段缺失的 part 返回 null
 */
export function translatePart(part: StreamPart, ctx: TurnEventContext): TurnEvent | null {
  switch (part.type) {
    case 'text-delta':
      // 运行时守卫：SDK 形状变化时静默跳过而非抛错
      if (part.delta === undefined) {
        return null;
      }
      return {
        ...ctx,
        type: TurnEventTypeConst.TEXT_DELTA,
        text: part.delta,
      };
    case 'tool-call':
      if (part.toolCallId === undefined || part.toolName === undefined) {
        return null;
      }
      return {
        ...ctx,
        type: TurnEventTypeConst.TOOL_CALL,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.args,
      };
    default:
      // step-start / step-finish / tool-result / finish / error / abort：
      // 由回合层（agent-service）按需处理，翻译器保持最小职责
      return null;
  }
}

/** 供类型收窄的辅助：判断翻译结果是否为指定类型（测试/工具用） */
export function isTurnEventOfType<E extends TurnEventType>(
  event: TurnEvent | null,
  type: E,
): event is Extract<TurnEvent, { type: E }> {
  return event !== null && event.type === type;
}
