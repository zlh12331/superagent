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
