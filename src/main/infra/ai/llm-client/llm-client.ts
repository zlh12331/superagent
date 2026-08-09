// src/main/infra/ai/llm-client/llm-client.ts
// LLM 客户端统一出口：模型级路由 + per-model 缓存 + 重试
// ──────────────────────────────────────────────────────────────
// 职责：
// - getModel(modelId)：模型级解析（ModelRegistry）→ 供应商工厂 → per-model 缓存
// - generateText：会话外工具化调用（标题生成 / 摘要 / 子代理），自带重试
// - reset：清空 per-model 缓存（API Key / 模型切换后重建实例）
//
// 设计（对标 qwen-code BaseLlmClient）：
// - 模型是路由最小单元：调用方传模型 id 即可，无需知道供应商
// - per-model 缓存避免重复创建 LanguageModel 实例
// - 供应商工厂通过 DI 注入（createProviderFactory），本层不感知 keychain / config
// - generateText 走 retryWithBackoff（错误码感知 + 指数退避 + 遥测回调）
// ──────────────────────────────────────────────────────────────

import {
  APICallError,
  generateObject as generateObjectAi,
  generateText as generateTextAi,
  type LanguageModel,
} from 'ai';
import type { ZodType } from 'zod';
import { logger } from '../../../utils/logger';
import { combineAbortSignals, createTimeoutSignal } from '../agent-runtime/abort-utils';
import { estimateTokenCount } from '../context-compression';
import type { ModelRegistry } from '../models';
import { buildGenerationOptions } from '../models/generation-options';
import type { ProviderKind } from '../providers/types';
import { getErrorCode, getErrorStatus, retryWithBackoff } from './retry';

/** 全局模型超时兜底（毫秒）：模型未自带 timeoutMs 时的默认总时长 */
const DEFAULT_MODEL_TIMEOUT_MS = 60_000;

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
  // Node/undici 网络层错误 + 超时 + 流中断：可降级
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
    options?: { readonly apiKey?: string; readonly baseUrl?: string },
  ) => Promise<(modelId: string) => LanguageModel>;
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
    const resolved = this.deps.modelRegistry.resolve(modelId);
    // 显式传入的 modelId 未注册（非内置条目、非运行时快照）：回退默认供应商透传。
    // 生产上多为配置错误（拼错模型名），打 warn 便于定位（resolve 本身保持纯函数）。
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
      resolved.explicitApiKey !== undefined || resolved.explicitBaseUrl !== undefined;
    const factory = await this.deps.createProviderFactory(
      resolved.providerKind,
      ...(hasExplicitOverride
        ? [
            {
              ...(resolved.explicitApiKey !== undefined ? { apiKey: resolved.explicitApiKey } : {}),
              ...(resolved.explicitBaseUrl !== undefined
                ? { baseUrl: resolved.explicitBaseUrl }
                : {}),
            },
          ]
        : []),
    );
    const model = factory(resolved.modelId);
    this.modelCache.set(resolved.modelId, model);
    logger.debug(
      {
        modelId: resolved.modelId,
        providerKind: resolved.providerKind,
        isRuntime: resolved.isRuntime,
      },
      'LlmClient 已创建 LanguageModel',
    );
    return model;
  }

  /**
   * 会话外工具化 LLM 调用（标题生成 / 摘要 / 子代理等）
   *
   * 自带重试（错误码感知 + 指数退避）与遥测回调。
   * 与主回合（streamText）独立：无工具调用、无多轮循环。
   *
   * 模型级生成参数适配（buildGenerationOptions 单一真源，与 agent 主流程共用）：
   * - 思考模型：注入 reasoningEffort（DeepSeek 按官方映射钳制），不传采样参数
   * - 非思考模型：应用 temperature / topP / maxTokens（窗口预算钳制）
   */
  async generateText(options: LlmGenerateTextOptions): Promise<LlmGenerateTextResult> {
    try {
      return await this.generateTextOnce(options);
    } catch (error) {
      // ModelFallback 降级链（对齐 qwen modelConfigResolver 配置级降级语义）：
      // 可降级错误（5xx / 网络 / 超时）且当前模型不是默认模型 → 降级默认模型重试一次
      const fallbackModel = this.deps.modelRegistry.resolve(undefined).modelId;
      // 未显式指定模型（undefined = 默认模型）或已是默认模型：降级无意义，直接抛
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
    // gpt-tokenizer 精确估算 prompt + system（输出预算钳制用）
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
   * 对标 qwen BaseLlmClient.generateJson：模型按 schema 输出（respond_in_schema），
   * 避免自由文本解析的脆弱性。自带重试与中断贯穿。
   */
  async generateJson<T>(options: LlmGenerateJsonOptions<T>): Promise<T> {
    return this.runSideQuery(options.model, options, async (model, signal) => {
      const result = await generateObjectAi({
        model,
        schema: options.schema,
        prompt: options.prompt,
        ...(options.system !== undefined ? { system: options.system } : {}),
        ...(signal !== undefined ? { abortSignal: signal } : {}),
      });
      return result.object;
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

    // 总时长超时：模型自带 timeoutMs 优先，全局默认（deps.defaultTimeoutMs）兜底
    const timeout = createTimeoutSignal(
      generationConfig?.timeoutMs ?? this.deps.defaultTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS,
    );
    // 有效信号 = 用户信号 + 模型级超时（超时触发后与用户中断同语义：不重试）
    const effectiveSignal = combineAbortSignals([options.signal, timeout?.signal]);
    // 重试次数：调用方显式 > 模型级 maxRetries（默认 2 次重试 = 3 次尝试）
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
      // 请求结束立即清理超时定时器（无论成功/失败/超时）
      timeout?.clear();
    }
  }

  /**
   * 失效单个模型的缓存实例
   *
   * 触发场景：运行时快照更新（baseUrl / apiKey 变更）后，同 modelId 的
   * 缓存仍持有旧配置，需主动失效；下次 getModel 重新创建。
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
