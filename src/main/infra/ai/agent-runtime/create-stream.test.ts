// src/main/infra/ai/agent-runtime/create-stream.test.ts
// 请求级重试链路单测：创建 + 首读重试 / 首包后不重试 / 首 part 接续

import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';
import { createStreamWithRetry, type MessageStreamSource } from './create-stream';

/** fake UiStreamable：可配置首读失败次数与失败错误 */
function createFakeStream(options: {
  firstReadFailures?: number;
  parts?: unknown[];
  error?: Error;
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

  it('限流错误（429）不重试，立即抛出（主流程快速失败语义）', async () => {
    const rateLimited = new APICallError({
      message: 'Rate limit exceeded',
      url: 'https://api.example.com/v1/chat/completions',
      requestBodyValues: undefined,
      statusCode: 429,
      responseBody: 'Too Many Requests',
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
    expect(createdCount()).toBe(1); // 429 不重试
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
