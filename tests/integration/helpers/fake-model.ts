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
  options?: { holdOpen?: boolean },
): LanguageModel {
  let call = 0;
  return {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-model',
    async doStream(input: { messages: unknown[]; abortSignal?: AbortSignal }) {
      const index = Math.min(call, rounds.length - 1);
      onCall?.(index, input.messages);
      const parts = rounds[index] ?? [];
      const normalized: Array<Record<string, unknown>> = [];
      let hasTextStart = false;
      for (const p of parts) {
        if (p.type === 'text-delta' && !hasTextStart) {
          normalized.push({ type: 'text-start', id: (p.id as string) ?? 'ts-1' });
          hasTextStart = true;
        }
        normalized.push(p);
      }
      call += 1;
      const stream = new ReadableStream<Record<string, unknown>>({
        start(controller) {
          for (const p of normalized) {
            controller.enqueue(p);
          }
          if (!(options?.holdOpen ?? false)) {
            controller.close();
          } else {
            input.abortSignal?.addEventListener(
              'abort',
              () => {
                try {
                  controller.close();
                } catch {}
              },
              { once: true },
            );
          }
        },
      });
      return { stream, rawCall: { id: `fake-call-${call}` } };
    },
  } as unknown as LanguageModel;
}

/** 常见 part 构造器（AI SDK v7 流协议） */
export const modelParts = {
  textDelta: (delta: string): Record<string, unknown> => ({
    type: 'text-delta',
    delta,
    id: `td-${delta.length}`,
  }),
  finish: (finishReason = 'stop'): Record<string, unknown> => ({
    type: 'finish',
    finishReason,
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  }),
  toolCall: (toolCallId: string, toolName: string, input: unknown): Record<string, unknown> => ({
    type: 'tool-call',
    toolCallId,
    toolName,
    input,
  }),
  reasoningStart: (id = 'rs-1'): Record<string, unknown> => ({ type: 'reasoning-start', id }),
  reasoningDelta: (delta: string, id = 'rs-1'): Record<string, unknown> => ({
    type: 'reasoning-delta',
    id,
    delta,
  }),
  reasoningEnd: (id = 'rs-1'): Record<string, unknown> => ({ type: 'reasoning-end', id }),
  error: (error: Error): Record<string, unknown> => ({ type: 'error', error }),
} as const;
