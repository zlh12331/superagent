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
import { estimateTokenCount } from '../agent/context-compression';
import { combineAbortSignals, createTimeoutSignal } from '../agent-runtime/abort-utils';
import { modelObservabilityMiddleware } from '../middleware/model-observability';
import type { ModelRegistry } from '../models';
import { buildGenerationOptions } from '../models/generation-options';
import type { ProviderKind } from '../providers/types';
import { getErrorCode, getErrorStatus, retryWithBackoff } from './retry';

const DEFAULT_MODEL_TIMEOUT_MS = 60_000;

type WrapableModel = Parameters<typeof wrapLanguageModel>[0]['model'];

const SDK_MODEL_CALL_RETRY_DISABLED = { maxRetries: 0 } as const;

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
}

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

export interface LlmGenerateJsonOptions<T> {
  readonly model?: string;
  readonly schema: ZodType<T>;
  readonly prompt: string;
  readonly system?: string;
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
}

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

  async generateText(options: LlmGenerateTextOptions): Promise<LlmGenerateTextResult> {
    try {
      return await this.generateTextOnce(options);
    } catch (error) {
      const fallbackModel = this.deps.modelRegistry.resolve(undefined).modelId;
      if (
        options.model === undefined ||
        options.model === fallbackModel ||
        !isFallbackEligibleError(error)
      ) {
        throw error;
      }
      logger.warn(
        { model: options.model, fallbackModel, error: (error as Error).message },
        '模型调用失败，降级默认模型重试（ModelFallback）',
      );
      return this.generateTextOnce({ ...options, model: fallbackModel });
    }
  }

  private async generateTextOnce(options: LlmGenerateTextOptions): Promise<LlmGenerateTextResult> {
    const promptTokens =
      estimateTokenCount(options.prompt) +
      (options.system !== undefined ? estimateTokenCount(options.system) : 0);
    const gen = buildGenerationOptions(
      this.deps.modelRegistry.resolve(options.model),
      promptTokens,
    );

    return this.runSideQuery(options.model, options, async (model, signal) => {
      const result = await generateTextAi({
        model,
        prompt: options.prompt,
        ...SDK_MODEL_CALL_RETRY_DISABLED,
        ...gen.samplingOptions,
        ...(gen.maxOutputTokens !== undefined ? { maxOutputTokens: gen.maxOutputTokens } : {}),
        ...(options.system !== undefined ? { system: options.system } : {}),
        ...(gen.providerOptions !== undefined ? { providerOptions: gen.providerOptions } : {}),
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
    return this.runSideQuery(options.model, options, async (model, signal) => {
      const result = await generateTextAi({
        model,
        output: Output.object({ schema: options.schema }),
        prompt: options.prompt,
        ...SDK_MODEL_CALL_RETRY_DISABLED,
        ...(options.system !== undefined ? { system: options.system } : {}),
        ...(signal !== undefined ? { abortSignal: signal } : {}),
      });
      return result.output;
    });
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
    const maxAttempts = options.maxAttempts ?? (generationConfig?.maxRetries ?? 2) + 1;

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
