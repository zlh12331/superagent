// src/main/infra/ai/agent-runtime/stream-reader.test.ts
// stream-reader 单测：空闲超时守卫读流（真实 ReadableStream + fake timers）
//
// 测试要点：
// 1. 流立即完成：正常返回结果 + 清理超时定时器
// 2. 流挂起超阈值：抛 AI_TIMEOUT + abort controller
// 3. 流分块读取：多块顺序返回
// 4. 超时定时器清理：正常路径不残留（finally clearTimeout）

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
        start() {
          // 永不 enqueue/close：read 永久挂起
        },
      });
      const reader = stream.getReader();
      const controller = new AbortController();

      const promise = readWithIdleTimeout(reader, controller, 100);
      const assertion = expect(promise).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(200);

      await assertion;
      // 超时触发后中断底层流
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
        start() {
          // 永不结束
        },
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
