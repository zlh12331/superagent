// tests/integration/helpers/fake-model.ts
// 集成测试共享基建：fake LLM model（AI SDK LanguageModel v2 外部边界替身）
// ──────────────────────────────────────────────────────────────
// 替身范围：LLM 是外部服务边界（允许替身，同仓业务全真实）。
// 用法：rounds 数组定义多轮响应（第一轮工具调用 → 第二轮最终文本等）；
// 每轮 parts 为 LanguageModelV2StreamPart 数组（start 自动前置，finish 由调用方给出）。
// ──────────────────────────────────────────────────────────────

import type { LanguageModel } from 'ai';

/**
 * 创建脚本化 fake model。
 *
 * @param rounds 每轮调用的 part 序列（含 finish；start 自动前置）
 * @param onCall 每轮调用的回调（可断言 messages 轮次内容）
 */
export function createFakeModel(
  rounds: Array<Array<Record<string, unknown>>>,
  onCall?: (callIndex: number, messages: unknown[]) => void,
): LanguageModel {
  let call = 0;
  return {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-model',
    async doStream(input: { messages: unknown[] }) {
      const index = Math.min(call, rounds.length - 1);
      onCall?.(index, input.messages);
      const parts = rounds[index] ?? [];
      call += 1;
      const stream = new ReadableStream<Record<string, unknown>>({
        start(controller) {
          // 注意：LanguageModelV2 流无 start part（start 是 UIMessageStream 层概念）
          for (const p of parts) {
            controller.enqueue(p);
          }
          controller.close();
        },
      });
      return { stream, rawCall: { id: `fake-call-${call}` } };
    },
  } as unknown as LanguageModel;
}

/** 常见 part 构造器（AI SDK v7 流协议） */
export const modelParts = {
  textDelta: (text: string): Record<string, unknown> => ({
    // LanguageModelV2 流的文本 part 字段是 text（delta 是 UIMessageStream 层字段）
    type: 'text-delta',
    text,
    id: `td-${text.length}`,
  }),
  finish: (finishReason = 'stop'): Record<string, unknown> => ({
    type: 'finish',
    finishReason,
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  }),
  toolCall: (toolCallId: string, toolName: string, args: unknown): Record<string, unknown> => ({
    type: 'tool-call',
    toolCallId,
    toolName,
    args,
  }),
  error: (error: Error): Record<string, unknown> => ({ type: 'error', error }),
} as const;
