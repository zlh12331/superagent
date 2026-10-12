import { describe, expect, it, vi } from 'vitest';
import { readWithIdleTimeout } from './stream-reader';

describe('stream-reader 批次14 缺口补全', () => {
  it('流立即完成：返回结果并清理超时定时器', async () => {
    const stream = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.close();
      },
    });
    const reader = stream.getReader();
    const controller = new AbortController();

    const result = await readWithIdleTimeout(reader, controller, 1_000);

    expect(result.done).toBe(false);
    expect(result.value).toBe(1);
  });

  it('流挂起超阈值：抛 AI_TIMEOUT 并 abort controller', async () => {
    vi.useFakeTimers();
    try {
      const stream = new ReadableStream<number>({
        start() {},
      });
      const reader = stream.getReader();
      const controller = new AbortController();

      const promise = readWithIdleTimeout(reader, controller, 100);
      const assertion = expect(promise).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(200);

      await assertion;
      expect(controller.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('流分块读取：多块按顺序返回', async () => {
    const stream = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(10);
        controller.enqueue(20);
        controller.close();
      },
    });
    const reader = stream.getReader();
    const controller = new AbortController();

    const first = await readWithIdleTimeout(reader, controller, 1_000);
    expect(first.value).toBe(10);
    const second = await readWithIdleTimeout(reader, controller, 1_000);
    expect(second.value).toBe(20);
    const end = await readWithIdleTimeout(reader, controller, 1_000);
    expect(end.done).toBe(true);
  });

  it('controller 缺省：超时仍抛 AI_TIMEOUT（不崩）', async () => {
    vi.useFakeTimers();
    try {
      const stream = new ReadableStream<number>({
        start() {},
      });
      const reader = stream.getReader();

      const promise = readWithIdleTimeout(reader, undefined, 100);
      const assertion = expect(promise).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(200);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
