import type { Span } from '@opentelemetry/api';
import type { Telemetry as AiTelemetry } from 'ai';

import { getTracer } from './otel';

/** 进行中的模型调用 span（按 SDK callId 关联 start/end） */
const activeModelSpans = new Map<string, Span>();

/**
 * 创建 AI SDK telemetry integration（模型调用级 span）
 *
 * 只监听 onLanguageModelCallStart/End；模型调用抛错且 End 回调未触发时
 * span 保留在 map 中（数量级极小，随进程结束释放，不设定期清理）。
 */
export function createSdkTelemetryIntegration(): AiTelemetry {
  return {
    onLanguageModelCallStart: (event) => {
      const tracer = getTracer();
      if (tracer === null) {
        return;
      }
      const span = tracer.startSpan('model.call', {
        attributes: {
          'model.provider': event.provider,
          'model.id': event.modelId,
          'ai.callId': event.callId,
        },
      });
      activeModelSpans.set(event.callId, span);
    },
    onLanguageModelCallEnd: (event) => {
      const span = activeModelSpans.get(event.callId);
      if (span === undefined) {
        return;
      }
      activeModelSpans.delete(event.callId);
      span.setAttribute('model.finishReason', event.finishReason);
      span.setAttribute('model.inputTokens', event.usage.inputTokens ?? 0);
      span.setAttribute('model.outputTokens', event.usage.outputTokens ?? 0);
      span.setAttribute('model.totalTokens', event.usage.totalTokens ?? 0);
      span.end();
    },
  };
}
