import { AppError, ErrorCode } from '@code-agent/shared/main';

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 600_000;

export async function readWithIdleTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  controller: AbortController | undefined,
  timeoutMs: number = DEFAULT_STREAM_IDLE_TIMEOUT_MS,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<T>['read']>>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller?.abort();
      reject(new AppError(ErrorCode.AI_TIMEOUT, 'AI 流式响应空闲超时'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([reader.read(), timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
