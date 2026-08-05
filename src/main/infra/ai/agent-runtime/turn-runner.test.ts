// src/main/infra/ai/agent-runtime/turn-runner.test.ts
// TurnRunner 单测：读流 → 翻译 → 事件产出 → 统计/终止原因

import { TurnEventType } from '@code-agent/shared/main';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnEventEmitter } from './turn-emitter';
import { TurnRunner } from './turn-runner';

/** 构造同步推送 parts 后关闭的 mock 流 */
function createMockStream(parts: unknown[]): ReadableStream<unknown> {
  return new ReadableStream<unknown>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

describe('TurnRunner', () => {
  let emitter: TurnEventEmitter;
  let controller: AbortController;
  const ctx = { sessionId: 's1', turnId: 't1', modelId: 'deepseek-v4-flash' };

  beforeEach(() => {
    emitter = new TurnEventEmitter();
    controller = new AbortController();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('正常流：产出 turn-start + text-delta 事件，返回 completed', async () => {
    const events: unknown[] = [];
    emitter.on(TurnEventType.TURN_START, (e) => events.push(e));
    emitter.on(TurnEventType.TEXT_DELTA, (e) => events.push(e));
    emitter.on(TurnEventType.TOOL_CALL, (e) => events.push(e));

    const runner = new TurnRunner({ ...ctx, controller, emitter, idleTimeoutMs: 60_000 });
    const result = await runner.run(
      createMockStream([
        { type: 'text-delta', delta: 'hi' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', args: {} },
        { type: 'finish', finishReason: 'stop' },
      ]),
    );

    expect(result.reason).toBe('completed');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // turn-start + 2 个翻译事件（finish 不翻译）
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: TurnEventType.TURN_START, modelId: ctx.modelId });
    expect(events[1]).toMatchObject({ type: TurnEventType.TEXT_DELTA, text: 'hi' });
    expect(events[2]).toMatchObject({
      type: TurnEventType.TOOL_CALL,
      toolCallId: 'c1',
      toolName: 'read_file',
    });
  });

  it('onPart 回调：每个 part 先回调（原始透传）', async () => {
    const onPart = vi.fn();
    const runner = new TurnRunner({ ...ctx, controller, emitter, onPart });
    const parts = [
      { type: 'text-delta', delta: 'a' },
      { type: 'text-delta', delta: 'b' },
    ];

    await runner.run(createMockStream(parts));

    expect(onPart).toHaveBeenCalledTimes(2);
    expect(onPart.mock.calls[0]?.[0]).toEqual({ type: 'text-delta', delta: 'a' });
  });

  it('用户中断（abort）：返回 reason=aborted', async () => {
    const runner = new TurnRunner({ ...ctx, controller, emitter });
    // 流中抛 AbortError（模拟 streamText 感知 abort 后中断）
    const stream = new ReadableStream<unknown>({
      start(controller_) {
        controller_.enqueue({ type: 'text-delta', delta: 'hi' });
        controller_.error(new DOMException('aborted', 'AbortError'));
      },
    });

    const result = await runner.run(stream);

    expect(result.reason).toBe('aborted');
  });

  it('非中断错误：抛出由上层分类', async () => {
    const runner = new TurnRunner({ ...ctx, controller, emitter });
    const stream = new ReadableStream<unknown>({
      start(controller_) {
        controller_.error(new Error('boom'));
      },
    });

    await expect(runner.run(stream)).rejects.toThrow('boom');
  });

  it('流空闲超时：中断并抛 AI_TIMEOUT', async () => {
    vi.useFakeTimers();
    const runner = new TurnRunner({ ...ctx, controller, emitter, idleTimeoutMs: 100 });
    // 永不推送的流
    const stream = new ReadableStream<unknown>({
      pull() {
        // 故意不 enqueue
      },
    });

    const promise = runner.run(stream);
    const assertion = expect(promise).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
  });
});
