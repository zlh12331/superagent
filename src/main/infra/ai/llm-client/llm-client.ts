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

/** 全局模型超时兜底（毫秒）：模型未自带 timeoutMs 时的默认总时长 */
const DEFAULT_MODEL_TIMEOUT_MS = 60_000;

/**
 * wrapLanguageModel 可接受的模型类型（LanguageModelV2|V3|V4）
 *
 * AI SDK 的 LanguageModel 还含 GlobalProviderModelId（id 字符串形态）；
 * 本层工厂恒返回真实 v4 实例，此处收窄让 wrap 入参类型通过。
 */
type WrapableModel = Parameters<typeof wrapLanguageModel>[0]['model'];

/**
 * 关闭 SDK 内置的 model call 级重试（side query 专用）
 *
 * side query 是单步调用，重试真源是本层 retryWithBackoff（Retry-After 优先、
 * 网络错误码识别、abort 贯穿、onRetry 遥测）。SDK 默认还会自己重试 2 次，
 * 两层相乘会把 maxAttempts=3 变成 9 次真实请求，故显式关掉。
 */
const SDK_MODEL_CALL_RETRY_DISABLED = { maxRetries: 0 } as const;

/**
 * 模型降级资格判定（ModelFallback）：
 * - 可降级：HTTP 5xx / SDK 网络层错误 / 超时 / 流中断（供应商侧故障，换默认模型可能可用）
 * - 不降级：401/400/402/429/模型不存在（Key/余额/限流/配置问题，换模型无意义）
 */
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

/**
 * LlmClient 依赖（DI 注入，便于测试替换 fake 实现）
 */
export interface LlmClientDeps {
  /** 模型注册表（模型级解析） */
  readonly modelRegistry: ModelRegistry;
  /** 全局模型超时兜底（毫秒；模型自带 timeoutMs 优先，DI 注入便于测试） */
  readonly defaultTimeoutMs?: number;
  /**
   * 创建供应商 LanguageModel 工厂
   *
   * 内部职责：keychain 读取 API Key、config baseUrl、按 kind 缓存工厂实例。
   * （对应 ai-provider 的 getAIProvider 内部逻辑）
   */
  readonly createProviderFactory: (
    kind: ProviderKind,
    options?: {
      readonly apiKey?: string;
      readonly baseUrl?: string;
      readonly apiFormat?: ModelApiFormat;
    },
  ) => Promise<(modelId: string) => LanguageModel>;
  /**
   * 模型配置门禁（可选）：每次获取模型前执行的校验。
   * 业务装配（ai-provider）注入"未配置任何启用模型时拒绝对话"的守卫；
   * 测试/内部工具可不注入（默认放行）。
   */
  readonly modelGate?: () => Promise<void>;
}

/**
 * generateText 调用参数（会话外 side query）
 */
export interface LlmGenerateTextOptions {
  /** 目标模型 id（省略 = 默认模型） */
  readonly model?: string;
  /** 系统提示词（可选） */
  readonly system?: string;
  /** 用户提示词 */
  readonly prompt: string;
  /** 重试次数上限（默认 3，side query 幂等可重试） */
  readonly maxAttempts?: number;
  /** 中断信号 */
  readonly signal?: AbortSignal;
}

/**
 * generateText 调用结果
 */
export interface LlmGenerateTextResult {
  readonly text: string;
  /** token 用量（供应商未返回时为 undefined） */
  readonly usage:
    | {
        readonly inputTokens?: number;
        readonly outputTokens?: number;
        readonly totalTokens?: number;
      }
    | undefined;
}

/**
 * generateJson 调用参数（结构化输出，对标 qwen BaseLlmClient.generateJson）
 */
export interface LlmGenerateJsonOptions<T> {
  /** 目标模型 id（省略 = 默认模型） */
  readonly model?: string;
  /** 输出结构约束（zod schema，模型按 schema 强制输出） */
  readonly schema: ZodType<T>;
  /** 用户提示词 */
  readonly prompt: string;
  /** 系统提示词（可选） */
  readonly system?: string;
  /** 重试次数上限（默认 3 次尝试） */
  readonly maxAttempts?: number;
  /** 中断信号 */
  readonly signal?: AbortSignal;
}

/**
 * LLM 客户端
 *
 * 模块级单例（ai-provider 层持有），ServiceContainer reset 时调用 reset()。
 */
export class LlmClient {
  /** per-model 缓存：模型 id → LanguageModel 实例 */
  private readonly modelCache = new Map<string, LanguageModel>();

  constructor(private readonly deps: LlmClientDeps) {}

  /**
   * 获取指定模型的 LanguageModel 实例（模型级解析 + 缓存）
   *
   * 解析流程：
   * 1. ModelRegistry.resolve(modelId)：显式 id 优先；未传/未注册 → 默认模型
   * 2. createProviderFactory(kind, { apiKey/baseUrl 覆盖 })：创建供应商工厂
   * 3. 工厂创建 LanguageModel，按模型 id 缓存（避免重复创建）
   *
   * @param modelId 目标模型 id（省略 = 默认供应商默认模型）
   * @returns LanguageModel 实例（供 streamText / generateText 使用）
   */
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
   * 会话外工具化 LLM 调用（标题生成 / 工具入参修复等）
   *
   * 自带重试（错误码感知 + 指数退避）与遥测回调。
   * 与主回合（streamText）独立：无工具调用、无多轮循环。
   *
   * ModelFallback 降级链：显式指定模型 + 可降级错误（5xx/网络/超时）→
   * 降级默认模型重试一次（见 catch 内实现）。
   *
   * 模型级生成参数适配（buildGenerationOptions 单一真源，与 agent 主流程共用）：
   * - 思考模型：注入 reasoningEffort（DeepSeek 按官方映射钳制），不传采样参数
   * - 非思考模型：应用 temperature / topP / maxTokens（窗口预算钳制）
   */
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

  /** 单模型调用（含重试与遥测；降级链的底层执行单元） */
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

  /**
   * 结构化输出调用（JSON schema 强制，标题提取 / 结构化任务等）
   *
   * 生产消费方：command-classifier（命令分类）/ goal-judge（目标判定）/
   * learn-skill-agent（技能学习）。
   *
   * 对标 qwen BaseLlmClient.generateJson：模型按 schema 输出（respond_in_schema），
   * 避免自由文本解析的脆弱性。自带重试与中断贯穿。
   *
   * 2026-09-11 迁移：由 `generateObject` 改为 `generateText` + `Output.object`
   * —— AI SDK v7 已废弃独立的结构化输出入口（`noDeprecatedImports` 报出），
   * 官方指引即「用 generateText 配 output 设置」。结果读取位置随之由
   * `result.object` 变为 `result.output`。
   * 注：`Output.object` 的 schema 描述会作为附加提示给模型（比 generateObject
   * 更贴底层），行为等价；返回类型仍受同一 ZodType 约束。
   */
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

  /**
   * 会话外调用统一执行器（side query 公共链路）
   *
   * 统一处理：模型解析 → per-model 缓存 → 模型级重试/超时配置 → 重试执行。
   * generateText / generateJson 共用，未来新增 side query 不再复制链路。
   *
   * 超时定时器手动清理：AbortSignal.timeout 在请求成功后不自动清理定时器
   * （未 abort），长超时 × 高频调用会堆积；此处请求结束立即 clear。
   */
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

  /**
   * 失效单个模型的缓存实例
   *
   * 设计触发场景：运行时快照更新（baseUrl / apiKey 变更）后，同 modelId 的
   * 缓存仍持有旧配置，需主动失效；下次 getModel 重新创建。
   *
   * 接线现状：settings.handler 的 addRuntimeModel / updateRuntimeModel /
   * removeRuntimeModel 三处已调用（模型配置变更后同 id 缓存不再残留旧配置）。
   */
  invalidateModel(modelId: string): void {
    this.modelCache.delete(modelId);
  }

  /**
   * 清空 per-model 缓存
   *
   * 触发场景：settings:setApiKey / 模型切换 / ServiceContainer.reset()。
   * 下次 getModel 重新创建实例（读取最新 keychain / config）。
   */
  reset(): void {
    this.modelCache.clear();
  }

  /** 当前缓存的模型实例数量（测试断言用） */
  getModelCacheSize(): number {
    return this.modelCache.size;
  }
}
