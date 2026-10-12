// model-observability.ts：AI SDK 中间件——generate/stream 前后记延迟与用量。
// 双轨：Attempt span（OTel，OTLP/Console 导出；未初始化 no-op）+ debug 日志（本地可读性）。
// 挂载点：llm-client wrapLanguageModel——所有经过实例的调用自动覆盖。
// Call 级聚合（一次逻辑调用的全部重试归一棵树）需要跨层传 attempt 关联 ID，
// 留待真实诊断需求驱动（见 model-observability 提交说明）。
import type { LanguageModelMiddleware } from 'ai';
import { logger } from '../../../utils/logger';
import { getTracer } from '../../telemetry/otel';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 活跃 Attempt span 上限（防泄漏：异常路径 end 丢失时最旧者被顶掉） */
const MAX_ACTIVE_SPANS = 64;

/** 活跃 Attempt span 登记（Map 保序——最旧在前） */
const activeSpans = new Map<import('@opentelemetry/api').Span, { readonly registeredAt: number }>();

function registerActiveSpan(span: import('@opentelemetry/api').Span): void {
  activeSpans.set(span, { registeredAt: Date.now() });
  while (activeSpans.size > MAX_ACTIVE_SPANS) {
    const oldest = activeSpans.entries().next().value;
    if (oldest === undefined) {
      break;
    }
    const [expiredSpan] = oldest;
    activeSpans.delete(expiredSpan);
    expiredSpan.setStatus({ code: 2, message: 'span evicted (active table overflow)' });
    expiredSpan.end();
  }
}

function unregisterActiveSpan(span: import('@opentelemetry/api').Span): void {
  activeSpans.delete(span);
}

/** 开一个 Attempt span（遥测未初始化时返回 null——调用方容忍） */
function startAttemptSpan(
  kind: 'generate' | 'stream',
  model: { provider: string; modelId: string },
): import('@opentelemetry/api').Span | null {
  const tracer = getTracer();
  if (tracer === null) {
    return null;
  }
  const span = tracer.startSpan(`model.attempt.${kind}`, {
    attributes: {
      'model.provider': model.provider,
      'model.id': model.modelId,
    },
  });
  registerActiveSpan(span);
  return span;
}

function endAttemptSpan(
  span: import('@opentelemetry/api').Span | null,
  attrs: Record<string, string | number | boolean>,
): void {
  if (span === null) {
    return;
  }
  unregisterActiveSpan(span);
  for (const [key, value] of Object.entries(attrs)) {
    span.setAttribute(key, value);
  }
  span.setStatus({ code: 1 });
  span.end();
}

/** usage → span 属性（只取数值字段；对象字段展平为点路径——OTel 属性须标量） */
function usageAttrs(
  usage:
    | {
        inputTokens?: { total?: number | undefined };
        outputTokens?: { total?: number | undefined };
      }
    | undefined,
): Record<string, number> {
  if (usage === undefined) {
    return {};
  }
  const attrs: Record<string, number> = {};
  if (usage.inputTokens?.total !== undefined) {
    attrs['usage.inputTokens'] = usage.inputTokens.total;
  }
  if (usage.outputTokens?.total !== undefined) {
    attrs['usage.outputTokens'] = usage.outputTokens.total;
  }
  return attrs;
}

function failAttemptSpan(
  span: import('@opentelemetry/api').Span | null,
  latencyMs: number,
  error: unknown,
): void {
  if (span === null) {
    return;
  }
  unregisterActiveSpan(span);
  span.setAttribute('latencyMs', latencyMs);
  span.recordException(error instanceof Error ? error : new Error(errorMessage(error)));
  span.setStatus({ code: 2, message: errorMessage(error) });
  span.end();
}

/** 从 CallOptions.providerOptions 提取逻辑调用 ID（L3 每次 generateText/streamText 生成，
 * codeagent 命名空间由 AI SDK 剥除不发给 provider）——Attempt span 借它与 model.call 父 span join */
function callIdFromParams(params: {
  readonly providerOptions?: Record<string, unknown> | undefined;
}): string | undefined {
  const codeagent = params.providerOptions?.['codeagent'];
  if (typeof codeagent !== 'object' || codeagent === null) {
    return undefined;
  }
  const callId = (codeagent as { callId?: unknown }).callId;
  return typeof callId === 'string' && callId.length > 0 ? callId : undefined;
}

export const modelObservabilityMiddleware: LanguageModelMiddleware = {
  wrapGenerate({ doGenerate, model, params }) {
    const startedAt = Date.now();
    const span = startAttemptSpan('generate', model);
    const callId = callIdFromParams(params);
    if (callId !== undefined && span !== null) {
      span.setAttribute('model.callId', callId);
    }
    return doGenerate().then(
      (result) => {
        const latencyMs = Date.now() - startedAt;
        endAttemptSpan(span, {
          latencyMs,
          ...usageAttrs(result.usage),
        });
        logger.debug(
          {
            provider: model.provider,
            modelId: model.modelId,
            latencyMs,
            ...(result.usage?.inputTokens !== undefined
              ? { inputTokens: result.usage.inputTokens }
              : {}),
            ...(result.usage?.outputTokens !== undefined
              ? { outputTokens: result.usage.outputTokens }
              : {}),
          },
          '模型生成调用完成',
        );
        return result;
      },
      (error) => {
        failAttemptSpan(span, Date.now() - startedAt, error);
        logger.warn(
          {
            provider: model.provider,
            modelId: model.modelId,
            latencyMs: Date.now() - startedAt,
            error: errorMessage(error),
          },
          '模型生成调用失败',
        );
        throw error;
      },
    );
  },

  wrapStream({ doStream, model, params }) {
    const startedAt = Date.now();
    const span = startAttemptSpan('stream', model);
    const callId = callIdFromParams(params);
    if (callId !== undefined && span !== null) {
      span.setAttribute('model.callId', callId);
    }
    return doStream().then(
      (result) => {
        // 流「建立成功」≠ 消费完成——Attempt span 在建立时即 end（attrs 标 established=true），
        // 流中途失败的观测属消费侧（TurnRunner），此处不越界
        endAttemptSpan(span, { latencyMs: Date.now() - startedAt, established: true });
        logger.debug(
          {
            provider: model.provider,
            modelId: model.modelId,
            latencyMs: Date.now() - startedAt,
          },
          '模型流式调用已建立',
        );
        return result;
      },
      (error) => {
        failAttemptSpan(span, Date.now() - startedAt, error);
        logger.warn(
          {
            provider: model.provider,
            modelId: model.modelId,
            latencyMs: Date.now() - startedAt,
            error: errorMessage(error),
          },
          '模型流式调用启动失败',
        );
        throw error;
      },
    );
  },
};
