// turn-translator.ts：模型流 part → 渲染层回合事件的翻译层（text-delta/tool-call 两型；其余丢弃）
import type { TurnEvent, TurnEventContext, TurnEventType } from '@code-agent/shared/main';
import { TurnEventType as TurnEventTypeConst } from '@code-agent/shared/main';

/** 模型流 part 的最小形状（字段不齐的 part 翻译为 null 丢弃） */
export interface StreamPart {
  readonly type: string;
  readonly delta?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly args?: unknown;
}

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

export function isTurnEventOfType<E extends TurnEventType>(
  event: TurnEvent | null,
  type: E,
): event is Extract<TurnEvent, { type: E }> {
  return event !== null && event.type === type;
}
