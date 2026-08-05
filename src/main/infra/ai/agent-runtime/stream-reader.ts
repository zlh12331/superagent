// src/main/infra/ai/agent-runtime/stream-reader.ts
// 共享流读取器：带空闲超时守卫的 reader.read（chat/agent 共用）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 从 agent-service 提取，消除 chat-service 与 agent-service 的读流复制
// - 流空闲超时：超时说明流已死（网络半开 / 服务端静默断连），
//   中断底层流（abort controller）并抛 AI_TIMEOUT，避免无限等待
//
// 设计（对齐 qwen streamIdleTimeout 思路）：
// - 每次 read 都带独立超时（读流循环中反复调用）
// - 超时阈值与供应商保活上限一致（默认 10 分钟），不误杀正常推理
// - abort 由调用方传入的 controller 触发（streamText 感知后停止推送）
// ──────────────────────────────────────────────────────────────

import { AppError, ErrorCode } from '@code-agent/shared/main';

/**
 * 流式响应空闲超时（毫秒）
 *
 * DeepSeek 官方保活上限 10 分钟：请求发出后 10 分钟未开始推理，服务端关闭连接。
 * 本地设置等长阈值，超时即中断死流并报 AI_TIMEOUT。
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 600_000;

/**
 * 带空闲超时守卫的流式读取
 *
 * @param reader 流读取器（toUIMessageStream().getReader() 的产物）
 * @param controller 中断控制器（超时/销毁时 abort，让 streamText 感知并释放资源）
 * @param timeoutMs 空闲超时毫秒数（默认 10 分钟）
 * @returns read 结果；超时抛 AppError(AI_TIMEOUT)
 */
export async function readWithIdleTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  controller: AbortController | undefined,
  timeoutMs: number = DEFAULT_STREAM_IDLE_TIMEOUT_MS,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<T>['read']>>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      // 中断底层流（streamText 感知 abortSignal 后停止推送）
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
