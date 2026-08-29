// src/main/infra/ai/agent-runtime/create-stream.test.ts
// 请求级重试链路单测：传输层失败重试 / HTTP 类交 SDK / 首包超时 / 首 part 接续

import { ErrorCode } from '@code-agent/shared/main';
import { APICallError, RetryError } from 'ai';
import { describe, expect, it } from 'vitest';
import { createStreamWithRetry, type MessageStreamSource } from './create-stream';

/** fake UiStreamable：可配置首读失败次数与失败错误 */
function createFakeStream(options: {
  firstReadFailures?: number;
  parts?: unknown[];
  error?: Error;
  /** 首包永不到达（触发读流空闲超时） */
  neverEmit?: boolean;
}): { streamable: MessageStreamSource; createdCount: () => number } {
  let created = 0;
  let failures = options.firstReadFailures ?? 0;
  const parts = options.parts ?? [{ type: 'text-delta', text: 'hello' }];
  // 默认 TypeError：isRetryableError 对 TypeError 返回 true（可重试语义）
  const failError = options.error ?? new TypeError('network failure');
  const streamable: MessageStreamSource = {
    toUIMessageStream() {
      created += 1;
      let idx = 0;
      return new ReadableStream<unknown>({
        pull(controller) {
          if (options.neverEmit === true) {
            // 悬挂：不产出也不结束，等读侧空闲超时
            return;
          }
          if (failures > 0) {
            failures -= 1;
            controller.error(failError);
            return;
          }
          if (idx < parts.length) {
            controller.enqueue(parts[idx]);
            idx += 1;
            return;
          }
          controller.close();
        },
      });
    },
  };
  return { streamable, createdCount: () => created };
}

describe('createStreamWithRetry', () => {
  it('首读失败自动重试，成功后返回首 part 与 reader', async () => {
    const { streamable, createdCount } = createFakeStream({ firstReadFailures: 2 });
    const created = await createStreamWithRetry({
      create: () => streamable,
      controller: new AbortController(),
      maxAttempts: 3,
    });
    expect(createdCount()).toBe(3); // 失败 2 次 + 成功 1 次
    expect(created.firstPart.done).toBe(false);
    expect((created.firstPart.value as { type: string }).type).toBe('text-delta');
    // 接续读取：reader 已预读首 part，后续读到流结束
    const next = await created.reader.read();
    expect(next.done).toBe(true);
  });

  it('重试耗尽后抛最后错误', async () => {
    const { streamable } = createFakeStream({ firstReadFailures: 5 });
    await expect(
      createStreamWithRetry({
        create: () => streamable,
        controller: new AbortController(),
        maxAttempts: 2,
      }),
    ).rejects.toThrow('network failure');
  });

  it('HTTP 类错误不在本层重试（model call 级重试真源是 SDK）', async () => {
    // 带 retry-after 的 429：SDK 已按该头定时长重试，本层再重试会放大请求数
    const rateLimited = new APICallError({
      message: 'Rate limit exceeded',
      url: 'https://api.example.com/v1/chat/completions',
      requestBodyValues: undefined,
      statusCode: 429,
      responseBody: 'Too Many Requests',
      responseHeaders: { 'retry-after': '1' },
    });
    const { streamable, createdCount } = createFakeStream({
      firstReadFailures: 3,
      error: rateLimited,
    });
    await expect(
      createStreamWithRetry({
        create: () => streamable,
        controller: new AbortController(),
        maxAttempts: 3,
      }),
    ).rejects.toThrow('Rate limit exceeded');
    expect(createdCount()).toBe(1);
  });

  it('SDK 重试耗尽（RetryError）不在本层再重试（避免两层尝试数相乘）', async () => {
    const exhausted = new RetryError({
      message: 'Failed after 3 attempts. Last error: HTTP 500',
      reason: 'maxRetriesExceeded',
      errors: [],
    });
    const { streamable, createdCount } = createFakeStream({
      firstReadFailures: 3,
      error: exhausted,
    });
    await expect(
      createStreamWithRetry({
        create: () => streamable,
        controller: new AbortController(),
        maxAttempts: 3,
      }),
    ).rejects.toThrow('Failed after 3 attempts');
    expect(createdCount()).toBe(1);
  });

  it('首包空闲超时：中断回合控制器且不重试（重试也必然被同一信号拒绝）', async () => {
    const { streamable, createdCount } = createFakeStream({ neverEmit: true });
    const controller = new AbortController();
    await expect(
      createStreamWithRetry({
        create: () => streamable,
        controller,
        idleTimeoutMs: 10,
        maxAttempts: 3,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.AI_TIMEOUT });
    expect(createdCount()).toBe(1);
    expect(controller.signal.aborted).toBe(true);
  });

  it('流立即结束（done 首读）', async () => {
    const { streamable } = createFakeStream({ parts: [] });
    const created = await createStreamWithRetry({
      create: () => streamable,
      controller: new AbortController(),
    });
    expect(created.firstPart.done).toBe(true);
  });

  it('返回 result 供调用方取 totalUsage', async () => {
    const { streamable } = createFakeStream({});
    const created = await createStreamWithRetry({
      create: () => streamable,
      controller: new AbortController(),
    });
    expect(created.result).toBe(streamable);
  });
});
