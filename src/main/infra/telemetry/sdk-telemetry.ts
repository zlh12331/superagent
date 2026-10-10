import type { Span } from '@opentelemetry/api';
import type { Telemetry as AiTelemetry } from 'ai';

import { getTracer } from './otel';

const activeModelSpans = new Map<string, Span>();

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
