// src/main/infra/ai/agent-runtime/turn-translator.test.ts
// turn-translator 单测：AI SDK part → TurnEvent 翻译

import { TurnEventType } from '@code-agent/shared/main';
import { describe, expect, it } from 'vitest';
import { isTurnEventOfType, translatePart } from './turn-translator';

const ctx = { sessionId: 's1', turnId: 't1', timestamp: 1000 };

describe('translatePart', () => {
  it('text-delta part → TurnTextDeltaEvent', () => {
    const event = translatePart({ type: 'text-delta', delta: 'hello' }, ctx);

    expect(event).toEqual({ ...ctx, type: TurnEventType.TEXT_DELTA, text: 'hello' });
  });

  it('tool-call part → TurnToolCallEvent（含入参）', () => {
    const event = translatePart(
      { type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', args: { path: '/a.ts' } },
      ctx,
    );

    expect(event).toEqual({
      ...ctx,
      type: TurnEventType.TOOL_CALL,
      toolCallId: 'c1',
      toolName: 'read_file',
      input: { path: '/a.ts' },
    });
  });

  it('不可翻译的 part（finish/step-start 等）→ null', () => {
    expect(translatePart({ type: 'finish', finishReason: 'stop' } as never, ctx)).toBeNull();
    expect(translatePart({ type: 'step-start' }, ctx)).toBeNull();
  });

  it('text-delta 缺 delta 字段（SDK 形状变化守卫）→ null', () => {
    expect(translatePart({ type: 'text-delta' } as never, ctx)).toBeNull();
  });

  it('tool-call 缺关键字段（SDK 形状变化守卫）→ null', () => {
    expect(translatePart({ type: 'tool-call', toolCallId: 'c1' } as never, ctx)).toBeNull();
  });
});

describe('isTurnEventOfType', () => {
  it('类型匹配：返回 true 且收窄类型', () => {
    const event = translatePart({ type: 'text-delta', delta: 'x' }, ctx);

    expect(isTurnEventOfType(event, TurnEventType.TEXT_DELTA)).toBe(true);
    expect(isTurnEventOfType(event, TurnEventType.TOOL_CALL)).toBe(false);
  });

  it('null 事件：返回 false', () => {
    expect(isTurnEventOfType(null, TurnEventType.TEXT_DELTA)).toBe(false);
  });
});
