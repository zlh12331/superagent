// src/main/infra/ai/agent-runtime/turn-emitter.test.ts
// TurnEventEmitter 单测：类型安全订阅/发布/退订

import type { TurnStartEvent } from '@code-agent/shared/main';
import { TurnEventType } from '@code-agent/shared/main';
import { describe, expect, it, vi } from 'vitest';
import { TurnEventEmitter } from './turn-emitter';

const ctx = { sessionId: 's1', turnId: 't1', timestamp: 1000 };

describe('TurnEventEmitter', () => {
  it('订阅并发布：同类型监听器收到事件', () => {
    const emitter = new TurnEventEmitter();
    const listener = vi.fn();

    emitter.on(TurnEventType.TEXT_DELTA, listener);
    emitter.emit({ ...ctx, type: TurnEventType.TEXT_DELTA, text: 'hi' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      ...ctx,
      type: TurnEventType.TEXT_DELTA,
      text: 'hi',
    });
  });

  it('按类型分桶：不同类型互不通知', () => {
    const emitter = new TurnEventEmitter();
    const deltaListener = vi.fn();
    const callListener = vi.fn();

    emitter.on(TurnEventType.TEXT_DELTA, deltaListener);
    emitter.on(TurnEventType.TOOL_CALL, callListener);
    emitter.emit({ ...ctx, type: TurnEventType.TEXT_DELTA, text: 'hi' });

    expect(deltaListener).toHaveBeenCalledTimes(1);
    expect(callListener).not.toHaveBeenCalled();
  });

  it('unsubscribe：退订后不再收到事件', () => {
    const emitter = new TurnEventEmitter();
    const listener = vi.fn();

    const unsubscribe = emitter.on(TurnEventType.TEXT_DELTA, listener);
    unsubscribe();
    emitter.emit({ ...ctx, type: TurnEventType.TEXT_DELTA, text: 'hi' });

    expect(listener).not.toHaveBeenCalled();
    expect(emitter.getListenerCount()).toBe(0);
  });

  it('无监听器时 emit 安全（不抛错）', () => {
    const emitter = new TurnEventEmitter();
    expect(() =>
      emitter.emit({ ...ctx, type: TurnEventType.TEXT_DELTA, text: 'hi' }),
    ).not.toThrow();
  });

  it('监听器抛错不阻断其他监听器', () => {
    const emitter = new TurnEventEmitter();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();

    emitter.on(TurnEventType.TEXT_DELTA, bad);
    emitter.on(TurnEventType.TEXT_DELTA, good);
    emitter.emit({ ...ctx, type: TurnEventType.TEXT_DELTA, text: 'hi' });

    expect(good).toHaveBeenCalledTimes(1);
  });

  it('类型安全：on 的 payload 按类型收窄（编译期验证）', () => {
    const emitter = new TurnEventEmitter();
    emitter.on(TurnEventType.TURN_START, (event: TurnStartEvent) => {
      expect(event.modelId).toBeDefined();
    });
    emitter.emit({
      ...ctx,
      type: TurnEventType.TURN_START,
      modelId: 'deepseek-v4-flash',
    });
    expect(emitter.getListenerCount()).toBe(1);
  });
});
