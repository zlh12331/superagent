// src/main/infra/telemetry/sdk-telemetry.ts
// AI SDK 遥测 → OTel span 轻量 integration（模型调用级）
// ──────────────────────────────────────────────────────────────
// 覆盖粒度分工（避免重复埋点）：
// - 回合级：agent-service withSpan('agent.streamText')（已存在）
// - 工具级：ToolExecutor withSpan('tool.execute')（已存在）
// - 模型级：本 integration —— 补上"单次 LLM 调用"粒度
//   （provider / modelId / latency / usage / finishReason）
//
// 父子关系：withSpan 使用 startActiveSpan 激活 context，AI SDK 的事件回调
// 在 streamText 的 async 链路上触发时继承 active context，本 integration
// 用 tracer.startSpan 创建的模型 span 自动成为回合 span 的子 span。
//
// 安全：不记录 prompt / 输出内容（recordInputs/Outputs 不开启），
// 对齐项目"错误脱敏"原则，避免敏感上下文进入遥测。
// ──────────────────────────────────────────────────────────────

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
