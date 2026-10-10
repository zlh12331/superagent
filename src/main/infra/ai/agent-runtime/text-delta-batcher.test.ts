import { describe, expect, it, vi } from 'vitest';

import {
  createTextDeltaBatcher,
  type TextDeltaBatcher,
  type TextDeltaBatcherOptions,
} from './text-delta-batcher';

/** 收集 emit 产物 */
function collect() {
  const emitted: unknown[] = [];
  return { emitted, emit: (part: unknown) => void emitted.push(part) };
}

/** 立即触发的假定时器（记录回调，flush 断言用） */
function makeManualScheduler() {
  const pending: Array<() => void> = [];
  const schedule: TextDeltaBatcherOptions['schedule'] = (callback) => {
    pending.push(callback);
    return () => {
      const idx = pending.indexOf(callback);
      if (idx !== -1) pending.splice(idx, 1);
    };
  };
  return { schedule, pending };
}

/** 创建注入假定时器的批处理器 */
function createWithManualTimer(options: Partial<TextDeltaBatcherOptions> = {}): {
  batcher: TextDeltaBatcher;
  emitted: unknown[];
  pending: Array<() => void>;
} {
  const { emitted, emit } = collect();
  const { schedule, pending } = makeManualScheduler();
  const batcher = createTextDeltaBatcher({ emit, schedule, ...options });
  return { batcher, emitted, pending };
}

describe('text-delta-batcher（P2-31 主进程合帧）', () => {
  it('相邻同 id text-delta 合并为单条，delta 文本按序拼接', () => {
    const { batcher, emitted } = createWithManualTimer();
    batcher.push({ type: 'text-delta', id: 't1', delta: 'he' });
    batcher.push({ type: 'text-delta', id: 't1', delta: 'llo' });
    expect(emitted).toHaveLength(0);
    batcher.flush();
    expect(emitted).toEqual([{ type: 'text-delta', id: 't1', delta: 'hello' }]);
  });

  it('窗口定时器到期自动落地缓冲（回调即 flush）', () => {
    const { batcher, emitted, pending } = createWithManualTimer();
    batcher.push({ type: 'text-delta', id: 't1', delta: 'x' });
    expect(pending).toHaveLength(1);
    pending[0]?.();
    expect(emitted).toEqual([{ type: 'text-delta', id: 't1', delta: 'x' }]);
    batcher.push({ type: 'text-delta', id: 't1', delta: 'y' });
    batcher.flush();
    expect(emitted).toEqual([
      { type: 'text-delta', id: 't1', delta: 'x' },
      { type: 'text-delta', id: 't1', delta: 'y' },
    ]);
  });

  it('不乱序：非 text-delta part 透出前先落地缓冲', () => {
    const { batcher, emitted } = createWithManualTimer();
    batcher.push({ type: 'text-delta', id: 't1', delta: 'a' });
    batcher.push({ type: 'text-delta', id: 't1', delta: 'b' });
    batcher.push({ type: 'tool-call', toolCallId: 'c1', toolName: 'read_file' });
    expect(emitted).toEqual([
      { type: 'text-delta', id: 't1', delta: 'ab' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'read_file' },
    ]);
  });

  it('不跨合：不同 id 的 text-delta 依次分段落地', () => {
    const { batcher, emitted } = createWithManualTimer();
    batcher.push({ type: 'text-delta', id: 't1', delta: 'a' });
    batcher.push({ type: 'text-delta', id: 't2', delta: 'b' });
    batcher.flush();
    expect(emitted).toEqual([
      { type: 'text-delta', id: 't1', delta: 'a' },
      { type: 'text-delta', id: 't2', delta: 'b' },
    ]);
  });

  it('不丢 part：高频并发交错（多 id + 非 delta part 混合）全量有序透出', () => {
    const { batcher, emitted } = createWithManualTimer();
    const pushed: unknown[] = [];
    for (let i = 0; i < 50; i++) {
      const parts = [
        { type: 'text-delta', id: 't1', delta: `a${i}` },
        { type: 'text-delta', id: 't2', delta: `b${i}` },
        { type: 'text-delta', id: 't1', delta: `c${i}` },
      ];
      if (i === 25) {
        parts.push({ type: 'tool-call', toolCallId: 'c1', toolName: 'run_command' } as never);
      }
      for (const part of parts) {
        pushed.push(part);
        batcher.push(part);
      }
    }
    batcher.flush();
    const textOf = (part: unknown): string =>
      typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text-delta'
        ? String((part as { delta?: string }).delta ?? '')
        : '';
    const mergedText = emitted.map(textOf).join('');
    const pushedText = pushed.map(textOf).join('');
    expect(mergedText).toBe(pushedText);
    const nonText = emitted.filter((p) => (p as { type?: string }).type !== 'text-delta');
    expect(nonText).toEqual([{ type: 'tool-call', toolCallId: 'c1', toolName: 'run_command' }]);
    expect(emitted.filter((p) => (p as { type?: string }).type === 'tool-call')).toHaveLength(1);
  });

  it('缓冲超字符上限立即落地（限制延迟与内存）', () => {
    const { batcher, emitted } = createWithManualTimer({ maxChars: 10 });
    batcher.push({ type: 'text-delta', id: 't1', delta: 'x'.repeat(6) });
    expect(emitted).toHaveLength(0);
    batcher.push({ type: 'text-delta', id: 't1', delta: 'y'.repeat(6) });
    expect(emitted).toEqual([
      { type: 'text-delta', id: 't1', delta: 'x'.repeat(6) + 'y'.repeat(6) },
    ]);
  });

  it('形状漂移防御：delta 非字符串的 text-delta 原样透传（不丢 part）', () => {
    const { batcher, emitted } = createWithManualTimer();
    batcher.push({ type: 'text-delta', textDelta: 'legacy-mock-shape' });
    expect(emitted).toEqual([{ type: 'text-delta', textDelta: 'legacy-mock-shape' }]);
  });

  it('flush 幂等；无缓冲时为 no-op', () => {
    const { batcher, emitted } = createWithManualTimer();
    batcher.push({ type: 'text-delta', id: 't1', delta: 'a' });
    batcher.flush();
    batcher.flush();
    batcher.flush();
    expect(emitted).toEqual([{ type: 'text-delta', id: 't1', delta: 'a' }]);
  });

  it('窗口到期后新缓冲重新计时（cancel 旧定时器，不重复落地）', () => {
    vi.useFakeTimers();
    try {
      const { emitted, emit } = collect();
      const batcher = createTextDeltaBatcher({ emit, batchMs: 20 });
      batcher.push({ type: 'text-delta', id: 't1', delta: 'a' });
      vi.advanceTimersByTime(20);
      batcher.push({ type: 'text-delta', id: 't1', delta: 'b' });
      vi.advanceTimersByTime(19);
      expect(emitted).toEqual([{ type: 'text-delta', id: 't1', delta: 'a' }]);
      vi.advanceTimersByTime(1);
      expect(emitted).toEqual([
        { type: 'text-delta', id: 't1', delta: 'a' },
        { type: 'text-delta', id: 't1', delta: 'b' },
      ]);
      vi.advanceTimersByTime(1000);
      expect(emitted).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
