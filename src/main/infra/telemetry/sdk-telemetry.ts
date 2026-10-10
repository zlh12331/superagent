// sdk-telemetry.ts：AI SDK 遥测集成——把模型调用的起止桥接成 OTel span（callId 关联起止）
import type { Span } from '@opentelemetry/api';
import type { Telemetry as AiTelemetry } from 'ai';

import { getTracer } from './otel';

// callId → 活跃 span：End 事件据此配对收口（遥测关闭时 Map 始终为空，零开销）
const activeModelSpans = new Map<string, Span>();

/** 传给 AI SDK 的 telemetry 钩子（llm-client 装配；token 用量记入 span 属性） */
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
