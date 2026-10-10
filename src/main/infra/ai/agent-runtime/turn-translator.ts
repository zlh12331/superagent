import type { TurnEvent, TurnEventContext, TurnEventType } from '@code-agent/shared/main';
import { TurnEventType as TurnEventTypeConst } from '@code-agent/shared/main';

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
