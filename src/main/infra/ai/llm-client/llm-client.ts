// llm-client.ts：LLM 客户端——generateText / generateJson（结构化 Output）两入口，
// 重试/超时/错误码归一收口；模型经 registry 解析 + 缓存，中间件挂可观测性

import { randomUUID } from 'node:crypto';
import { AppError, ErrorCode, type ModelApiFormat } from '@code-agent/shared/main';
import {
  APICallError,
  generateText as generateTextAi,
  type LanguageModel,
  Output,
  wrapLanguageModel,
} from 'ai';
import type { ZodType } from 'zod';
import { logger } from '../../../utils/logger';
import { createSdkTelemetryIntegration } from '../../telemetry/sdk-telemetry';
import { estimateTokenCount } from '../agent/context-compression';
import { combineAbortSignals, createTimeoutSignal } from '../agent-runtime/abort-utils';
import { modelObservabilityMiddleware } from '../middleware/model-observability';
import type { ModelRegistry } from '../models';
import { buildGenerationOptions } from '../models/generation-options';
import type { ProviderKind } from '../providers/types';
import { getErrorCode, getErrorStatus, resolveEnvRetryMaxRetries, retryWithBackoff } from './retry';

const DEFAULT_MODEL_TIMEOUT_MS = 60_000;

type WrapableModel = Parameters<typeof wrapLanguageModel>[0]['model'];

// SDK 内层重试关死：重试统一收口在本文件 retryWithBackoff（双层重试会放大延迟）
const SDK_MODEL_CALL_RETRY_DISABLED = { maxRetries: 0 } as const;

// 可重试判据：5xx / SDK 标记可重试的 API 错误 / 网络层错误码（连接重置、超时、socket 断）
function isFallbackEligibleError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status !== undefined) {
    return status >= 500 && status < 600;
  }
  if (error instanceof APICallError) {
    return error.isRetryable === true;
  }
  const code = getErrorCode(error);
  if (code !== undefined) {
    return (
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_SOCKET'
    );
  }
  return false;
}

/** 客户端依赖：模型注册表 + 供应商工厂 + 可选模型级 gate（限流闸）与默认超时 */
export interface LlmClientDeps {
  readonly modelRegistry: ModelRegistry;
  readonly defaultTimeoutMs?: number;
  readonly createProviderFactory: (
    kind: ProviderKind,
    options?: {
      readonly apiKey?: string;
      readonly baseUrl?: string;
      readonly apiFormat?: ModelApiFormat;
    },
  ) => Promise<(modelId: string) => LanguageModel>;
  readonly modelGate?: () => Promise<void>;
  /**
   * 限流上报：side query 重试观测到 429 时调用（durationMs = 建议冷却时长）。
   * 由装配方（ai-provider）接到并发门 coolDown——side query 与主回合共享同一冷却状态。
   */
  readonly notifyRateLimited?: (durationMs: number) => void;
}

/** 文本生成入参（model 缺省走默认模型；signal 可中止） */
export interface LlmGenerateTextOptions {
  readonly model?: string;
  readonly system?: string;
  readonly prompt: string;
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
}

export interface LlmGenerateTextResult {
  readonly text: string;
  readonly usage:
    | {
        readonly inputTokens?: number;
        readonly outputTokens?: number;
        readonly totalTokens?: number;
      }
    | undefined;
}

/** 结构化 JSON 生成入参（schema 驱动 AI SDK Output；T 为 zod 推导类型） */
export interface LlmGenerateJsonOptions<T> {
  readonly model?: string;
  readonly schema: ZodType<T>;
  readonly prompt: string;
  readonly system?: string;
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
}

/** LLM 客户端：模型实例按 modelId 缓存；generateText/generateJson 全带重试+超时+统一错误归一 */
export class LlmClient {
  private readonly modelCache = new Map<string, LanguageModel>();

  constructor(private readonly deps: LlmClientDeps) {}

  async getModel(modelId?: string): Promise<LanguageModel> {
    if (this.deps.modelGate !== undefined) {
      await this.deps.modelGate();
    }
    const resolved = this.deps.modelRegistry.resolve(modelId);
    if (!resolved.available) {
      throw new AppError(ErrorCode.MODEL_DISABLED, undefined, undefined, { modelId });
    }
    if (
      modelId !== undefined &&
      resolved.modelId === modelId &&
      !resolved.isRuntime &&
      this.deps.modelRegistry.findBuiltin(modelId) === undefined
    ) {
      logger.warn(
        { modelId, providerKind: resolved.providerKind },
        '未知模型 id：回退默认供应商透传（请检查模型配置）',
      );
    }
    const cached = this.modelCache.get(resolved.modelId);
    if (cached !== undefined) {
      return cached;
    }

    const hasExplicitOverride =
      resolved.explicitApiKey !== undefined ||
      resolved.explicitBaseUrl !== undefined ||
      resolved.apiFormat !== undefined;
    const factory = await this.deps.createProviderFactory(
      resolved.providerKind,
      ...(hasExplicitOverride
        ? [
            {
              ...(resolved.explicitApiKey !== undefined ? { apiKey: resolved.explicitApiKey } : {}),
              ...(resolved.explicitBaseUrl !== undefined
                ? { baseUrl: resolved.explicitBaseUrl }
                : {}),
              ...(resolved.apiFormat !== undefined ? { apiFormat: resolved.apiFormat } : {}),
            },
          ]
        : []),
    );
    const model = factory(resolved.modelId);
    const wrappedModel = wrapLanguageModel({
      model: model as WrapableModel,
      middleware: modelObservabilityMiddleware,
    });
    this.modelCache.set(resolved.modelId, wrappedModel);
    logger.debug(
      {
        modelId: resolved.modelId,
        providerKind: resolved.providerKind,
        isRuntime: resolved.isRuntime,
      },
      'LlmClient 已创建 LanguageModel',
    );
    return wrappedModel;
  }

  /**
   * ModelFallback 包装：显式指定模型（≠默认模型）调用失败且错误可降级
   * （5xx/SDK 标记可重试/网络错）时，降级默认模型重试一次。
   *
   * generateText / generateJson 共用；调用方未显式指定模型时原样透传（默认模型降级无意义）。
   */
  private async withModelFallback<T>(
    model: string | undefined,
    run: (modelId: string | undefined) => Promise<T>,
  ): Promise<T> {
    try {
      return await run(model);
    } catch (error) {
      const fallbackModel = this.deps.modelRegistry.resolve(undefined).modelId;
      if (model === undefined || model === fallbackModel || !isFallbackEligibleError(error)) {
        throw error;
      }
      logger.warn(
        { model, fallbackModel, error: (error as Error).message },
        '模型调用失败，降级默认模型重试（ModelFallback）',
      );
      return run(fallbackModel);
    }
  }

  async generateText(options: LlmGenerateTextOptions): Promise<LlmGenerateTextResult> {
    return this.withModelFallback(options.model, (modelId) =>
      this.generateTextOnce({ ...options, ...(modelId !== undefined ? { model: modelId } : {}) }),
    );
  }

  private async generateTextOnce(options: LlmGenerateTextOptions): Promise<LlmGenerateTextResult> {
    const promptTokens =
      estimateTokenCount(options.prompt) +
      (options.system !== undefined ? estimateTokenCount(options.system) : 0);
    const gen = buildGenerationOptions(
      this.deps.modelRegistry.resolve(options.model),
      promptTokens,
    );
    // 逻辑调用 ID：Attempt span（middleware）与 model.call 父 span（telemetry 回调）的 join 键
    const callId = randomUUID();
    const telemetryHooks = createSdkTelemetryIntegration();

    return this.runSideQuery(options.model, options, async (model, signal) => {
      const result = await generateTextAi({
        model,
        prompt: options.prompt,
        ...SDK_MODEL_CALL_RETRY_DISABLED,
        ...gen.samplingOptions,
        ...(gen.maxOutputTokens !== undefined ? { maxOutputTokens: gen.maxOutputTokens } : {}),
        ...(options.system !== undefined ? { system: options.system } : {}),
        ...(gen.providerOptions !== undefined ? { providerOptions: gen.providerOptions } : {}),
        providerOptions: {
          ...(gen.providerOptions ?? {}),
          codeagent: { callId },
        },
        ...(telemetryHooks.onLanguageModelCallStart !== undefined
          ? { onLanguageModelCallStart: telemetryHooks.onLanguageModelCallStart }
          : {}),
        ...(telemetryHooks.onLanguageModelCallEnd !== undefined
          ? { onLanguageModelCallEnd: telemetryHooks.onLanguageModelCallEnd }
          : {}),
        ...(signal !== undefined ? { abortSignal: signal } : {}),
      });
      const usage = result.usage;
      return {
        text: result.text,
        usage:
          usage !== undefined && usage !== null && Object.keys(usage).length > 0
            ? {
                ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
                ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
                ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
              }
            : undefined,
      };
    });
  }

  async generateJson<T>(options: LlmGenerateJsonOptions<T>): Promise<T> {
    return this.withModelFallback(options.model, (modelId) =>
      this.runSideQuery(modelId, options, async (model, signal) => {
        const result = await generateTextAi({
          model,
          output: Output.object({ schema: options.schema }),
          prompt: options.prompt,
          ...SDK_MODEL_CALL_RETRY_DISABLED,
          ...(options.system !== undefined ? { system: options.system } : {}),
          ...(signal !== undefined ? { abortSignal: signal } : {}),
        });
        return result.output;
      }),
    );
  }

  private async runSideQuery<T>(
    modelId: string | undefined,
    options: { readonly maxAttempts?: number; readonly signal?: AbortSignal },
    fn: (model: LanguageModel, signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<T> {
    const resolved = this.deps.modelRegistry.resolve(modelId);
    const generationConfig = resolved.generationConfig;
    const model = await this.getModel(resolved.modelId);

    const timeout = createTimeoutSignal(
      generationConfig?.timeoutMs ?? this.deps.defaultTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS,
    );
    const effectiveSignal = combineAbortSignals([options.signal, timeout?.signal]);
    // 重试次数优先级：调用方显式 > 模型 generationConfig > 环境变量 > 默认 2（尝试数 = 次数 + 1）
    const maxAttempts =
      options.maxAttempts ??
      (generationConfig?.maxRetries ?? resolveEnvRetryMaxRetries(process.env)) + 1;

    try {
      return await retryWithBackoff(() => fn(model, effectiveSignal), {
        maxAttempts,
        ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
        onRetry: (info) => {
          logger.warn(
            {
              modelId: resolved.modelId,
              attempt: info.attempt,
              errorStatus: info.errorStatus,
              delayMs: info.delayMs,
            },
            'side query 重试',
          );
          // 429 = provider 限流：上报冷却（min(建议值, Retry-After) 由装配方裁决），主回合闸同步受益
          if (info.errorStatus === 429 && this.deps.notifyRateLimited !== undefined) {
            this.deps.notifyRateLimited(info.delayMs);
          }
        },
      });
    } finally {
      timeout?.clear();
    }
  }

  invalidateModel(modelId: string): void {
    this.modelCache.delete(modelId);
  }

  reset(): void {
    this.modelCache.clear();
  }

  getModelCacheSize(): number {
    return this.modelCache.size;
  }
}
