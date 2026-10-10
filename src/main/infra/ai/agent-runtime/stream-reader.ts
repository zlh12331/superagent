// stream-reader.ts：模型流读取——单次 read 竞速空闲超时（10 分钟无数据判死，abort 上游流）
import { AppError, ErrorCode } from '@code-agent/shared/main';

// 10 分钟：深度思考模型长推理也可能静默数分钟，阈值须远大于常规响应
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 600_000;

/** 读一格（带空闲超时）；超时会 abort controller 并抛 AI_TIMEOUT */
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
