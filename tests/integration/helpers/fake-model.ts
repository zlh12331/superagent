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
      // v4 流协议：text-delta 前需要 text-start（SDK 流状态机；tool-call 不需）
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
          // 注意：LanguageModel 流无 start part（start 是 UIMessageStream 层概念）
          for (const p of normalized) {
            controller.enqueue(p);
          }
          // holdOpen：流挂起（abort 场景——模拟长时间生成中的模型）
          if (!(options?.holdOpen ?? false)) {
            controller.close();
          } else {
            // 真实 provider 行为：abort 信号触发时中断流（SDK 等 chunk 才检测 abort，
            // 挂起流必须响应 abort 否则中断不可达）
            input.abortSignal?.addEventListener(
              'abort',
              () => {
                try {
                  controller.close();
                } catch {
                  // 流已关闭：忽略
                }
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
    // v4 流协议：text-delta 用 delta 字段（text-start 由 createFakeModel 自动前置）
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
    // v4 流协议：tool-call 用 input 字段（args 不被 SDK parseToolCall 识别）
    type: 'tool-call',
    toolCallId,
    toolName,
    input,
  }),
  error: (error: Error): Record<string, unknown> => ({ type: 'error', error }),
} as const;
