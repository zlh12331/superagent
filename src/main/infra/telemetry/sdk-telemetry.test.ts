// src/main/infra/telemetry/sdk-telemetry.test.ts
// sdk-telemetry 单测：AI SDK telemetry integration（模型调用级 span）
// ──────────────────────────────────────────────────────────────
// 覆盖：
// - onLanguageModelCallStart → startSpan（provider/modelId/callId attributes）
// - onLanguageModelCallEnd → 补 usage / finishReason 并 end
// - end 未配对 start → 静默跳过（不 end 不抛）
// - getTracer 为 null（OTel 未初始化）→ 不创建 span
// ──────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const span = { setAttribute: vi.fn(), end: vi.fn() };
  const tracer = { startSpan: vi.fn(() => span) };
  return { span, tracer };
});

vi.mock('./otel', () => ({
  getTracer: vi.fn(() => mocks.tracer),
}));

import { getTracer } from './otel';
import { createSdkTelemetryIntegration } from './sdk-telemetry';

describe('createSdkTelemetryIntegration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tracer.startSpan.mockReturnValue(mocks.span);
    vi.mocked(getTracer).mockReturnValue(mocks.tracer);
  });

  it('start：创建 model.call span（provider/modelId/callId attributes）', () => {
    const integration = createSdkTelemetryIntegration();
    integration.onLanguageModelCallStart?.({
      provider: 'deepseek',
      modelId: 'deepseek-chat',
      callId: 'c1',
    } as never);

    expect(mocks.tracer.startSpan).toHaveBeenCalledWith('model.call', {
      attributes: {
        'model.provider': 'deepseek',
        'model.id': 'deepseek-chat',
        'ai.callId': 'c1',
      },
    });
  });

  it('end：补 usage / finishReason 并 end span', () => {
    const integration = createSdkTelemetryIntegration();
    integration.onLanguageModelCallStart?.({
      provider: 'p',
      modelId: 'm',
      callId: 'c1',
    } as never);
    integration.onLanguageModelCallEnd?.({
      callId: 'c1',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    } as never);

    expect(mocks.span.setAttribute).toHaveBeenCalledWith('model.finishReason', 'stop');
    expect(mocks.span.setAttribute).toHaveBeenCalledWith('model.inputTokens', 10);
    expect(mocks.span.setAttribute).toHaveBeenCalledWith('model.outputTokens', 5);
    expect(mocks.span.setAttribute).toHaveBeenCalledWith('model.totalTokens', 15);
    expect(mocks.span.end).toHaveBeenCalledTimes(1);
  });

  it('end 未配对 start：静默跳过（不 end 不抛）', () => {
    const integration = createSdkTelemetryIntegration();
    integration.onLanguageModelCallEnd?.({
      callId: 'nope',
      finishReason: 'stop',
      usage: {},
    } as never);

    expect(mocks.span.end).not.toHaveBeenCalled();
  });

  it('getTracer 为 null（OTel 未初始化）：不创建 span', () => {
    vi.mocked(getTracer).mockReturnValue(null);
    const integration = createSdkTelemetryIntegration();
    integration.onLanguageModelCallStart?.({
      provider: 'p',
      modelId: 'm',
      callId: 'c1',
    } as never);

    expect(mocks.tracer.startSpan).not.toHaveBeenCalled();
  });
});
