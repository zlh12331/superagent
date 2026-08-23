// src/main/infra/memory-hub/capture-wire.test.ts
// MemoryCaptureWire 单测：回合事件订阅 → L0 自动捕获
// ──────────────────────────────────────────────────────────────
// 验证点：
// - extractLastUserText 容错解析（string parts / 数组 parts / content 回退）
// - text-delta 累积 → turn-end(completed) 一次性 capture
// - 非 completed 结束不捕获；noteLastUser 修剪；unmount 解除订阅
// ──────────────────────────────────────────────────────────────

import type { TurnEvent } from '@code-agent/shared/main';

import { TurnEventType } from '@code-agent/shared/main';
import { describe, expect, it, vi } from 'vitest';
import type { IAgentService } from '../ai/agent/agent-service';
import { createMemoryCaptureWire, extractLastUserText } from './capture-wire';
import type { MemoryPort } from './types';

function ctx(sessionId: string, overrides: Partial<TurnEvent> = {}): Record<string, unknown> {
  return {
    sessionId,
    turnId: 'turn-1',
    timestamp: 1,
    ...overrides,
  };
}

describe('extractLastUserText', () => {
  it('非数组输入 → 空串', () => {
    expect(extractLastUserText(null)).toBe('');
    expect(extractLastUserText('not-array')).toBe('');
  });

  it('string parts：取最后一条用户消息', () => {
    const messages = [
      { role: 'user', parts: '第一问' },
      { role: 'assistant', parts: '第一答' },
      { role: 'user', parts: '第二问' },
    ];
    expect(extractLastUserText(messages)).toBe('第二问');
  });

  it('数组 parts：拼接 text 片段', () => {
    const messages = [
      {
        role: 'user',
        parts: [
          { type: 'text', text: '你好' },
          { type: 'text', text: '世界' },
        ],
      },
    ];
    expect(extractLastUserText(messages)).toBe('你好\n世界');
  });

  it('数组 parts 全空 → 回退 content 字段', () => {
    const messages = [
      { role: 'user', parts: [{ type: 'tool', text: undefined }], content: '回退内容' },
    ];
    expect(extractLastUserText(messages)).toBe('回退内容');
  });

  it('最后一条是 assistant → 继续向前找 user', () => {
    const messages = [
      { role: 'user', parts: '唯一问题' },
      { role: 'assistant', parts: '回答' },
    ];
    expect(extractLastUserText(messages)).toBe('唯一问题');
  });
});

describe('createMemoryCaptureWire', () => {
  function setup() {
    const capture = vi.fn(async () => ({ l0Recorded: 1, schedulerNotified: true }));
    const port = { capture } as unknown as MemoryPort;
    let listener: ((event: TurnEvent) => void) | null = null;
    const agentService = {
      onTurnEvent: vi.fn((fn: (event: TurnEvent) => void) => {
        listener = fn;
        return () => {
          listener = null;
        };
      }),
    } as unknown as IAgentService;
    const wire = createMemoryCaptureWire({ agentService, port });
    const emit = (event: TurnEvent): void => listener?.(event);
    return { wire, port, capture, agentService, emit };
  }

  it('挂载时订阅 onTurnEvent 一次', () => {
    const { agentService } = setup();
    expect(agentService.onTurnEvent).toHaveBeenCalledTimes(1);
  });

  it('turn-start + text-delta 累积 + turn-end(completed) → capture 一次', async () => {
    const { emit, capture, wire } = setup();
    wire.noteLastUser('sess-1', ' 用户问题 ');
    emit({ ...ctx('sess-1'), type: TurnEventType.TURN_START, modelId: 'm' } as never);
    emit({ ...ctx('sess-1'), type: TurnEventType.TEXT_DELTA, text: '你好' } as never);
    emit({ ...ctx('sess-1'), type: TurnEventType.TEXT_DELTA, text: '世界' } as never);
    emit({
      ...ctx('sess-1'),
      type: TurnEventType.TURN_END,
      reason: 'completed',
      durationMs: 10,
    } as never);
    // capture 内部有 void 异步，等待微任务
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(capture).toHaveBeenCalledWith({
      sessionKey: 'sess-1',
      userContent: '用户问题', // noteLastUser 已 trim
      assistantContent: '你好世界',
    });
  });

  it('turn-end 非 completed → 不 capture', async () => {
    const { emit, capture, wire } = setup();
    wire.noteLastUser('sess-1', '问题');
    emit({ ...ctx('sess-1'), type: TurnEventType.TURN_START, modelId: 'm' } as never);
    emit({
      ...ctx('sess-1'),
      type: TurnEventType.TURN_END,
      reason: 'aborted',
      durationMs: 10,
    } as never);
    await Promise.resolve();
    await Promise.resolve();
    expect(capture).not.toHaveBeenCalled();
  });

  it('无 text-delta：assistantContent 为空串', async () => {
    const { emit, capture, wire } = setup();
    wire.noteLastUser('sess-1', '问题');
    emit({ ...ctx('sess-1'), type: TurnEventType.TURN_START, modelId: 'm' } as never);
    emit({
      ...ctx('sess-1'),
      type: TurnEventType.TURN_END,
      reason: 'completed',
      durationMs: 10,
    } as never);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(capture).toHaveBeenCalledWith({
      sessionKey: 'sess-1',
      userContent: '问题',
      assistantContent: '',
    });
  });

  it('noteLastUser 空文本不记录', async () => {
    const { emit, capture, wire } = setup();
    wire.noteLastUser('sess-1', '   ');
    emit({ ...ctx('sess-1'), type: TurnEventType.TURN_START, modelId: 'm' } as never);
    emit({
      ...ctx('sess-1'),
      type: TurnEventType.TURN_END,
      reason: 'completed',
      durationMs: 10,
    } as never);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(capture).toHaveBeenCalledWith({
      sessionKey: 'sess-1',
      userContent: '',
      assistantContent: '',
    });
  });

  it('unmount 解除订阅后不再捕获', async () => {
    const { emit, capture, wire } = setup();
    wire.noteLastUser('sess-1', '问题');
    wire.unmount();
    emit({ ...ctx('sess-1'), type: TurnEventType.TURN_START, modelId: 'm' } as never);
    emit({
      ...ctx('sess-1'),
      type: TurnEventType.TURN_END,
      reason: 'completed',
      durationMs: 10,
    } as never);
    await Promise.resolve();
    await Promise.resolve();
    expect(capture).not.toHaveBeenCalled();
  });

  it('capture 抛错被吞掉（不向上冒泡）', async () => {
    const { emit, capture, wire } = setup();
    capture.mockRejectedValueOnce(new Error('boom'));
    wire.noteLastUser('sess-1', '问题');
    emit({ ...ctx('sess-1'), type: TurnEventType.TURN_START, modelId: 'm' } as never);
    emit({
      ...ctx('sess-1'),
      type: TurnEventType.TURN_END,
      reason: 'completed',
      durationMs: 10,
    } as never);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
  });
});
