// src/main/infra/ai/providers/registry.ts
// Provider 注册表（Code Agent 模板核心扩展点）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 集中注册内置供应商（deepseek / openai / anthropic / ollama）
// - 提供按 kind 查找定义与创建 LanguageModel 工厂的入口
// - 提供注册表快照（settings 域列出可选供应商用）
//
// 设计（对标 OpenCode 的 provider 路由）：
// - 新增供应商 = 新增一个 ProviderDefinition + 一个 ProviderFactory，
//   在 registerBuiltinProviders 中追加一行注册即可
// - deepseek / ollama 复用 OpenAI Compatible 协议（@ai-sdk/openai-compatible）
// - openai 使用官方 @ai-sdk/openai，anthropic 使用官方 @ai-sdk/anthropic
// - 每个供应商的 API Key 独立存储（keychain，key 前缀 = kind）
// ──────────────────────────────────────────────────────────────

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

import { getAppConfig } from '../../../config';
// 单一真源：默认模型 / 默认供应商由模型领域层定义（避免双源维护路由分裂）
import { DEFAULT_KIND, DEFAULT_MODEL_BY_KIND } from '../models/builtin-models';
import type {
  ProviderDefinition,
  ProviderFactory,
  ProviderInfo,
  ProviderKind,
  RegisteredProvider,
} from './types';

/**
 * 默认 API Key 前缀（与早期版本 keychain key 命名保持一致）
 *
 * keychain key 命名规则：'<provider-kind>-api-key'
 * - deepseek → 'deepseek-api-key'
 * - openai → 'openai-api-key'
 * - anthropic → 'anthropic-api-key'
 * - ollama → 无需 API Key（本地服务）
 */
export function toKeychainKey(kind: ProviderKind): string {
  return `${kind}-api-key`;
}

/**
 * 供应商在 AI SDK 中的 provider name（providerOptions 键）
 *
 * 约定收敛点：createOpenAICompatible({ name: 'deepseek' }) / 官方 SDK
 * 默认 name 均与 ProviderKind 同名。LlmClient 构造 providerOptions 时
 * 必须经此函数取键，禁止直接硬编码 kind——未来工厂改名只改这里。
 */
export function getProviderName(kind: ProviderKind): string {
  return kind;
}

/**
 * 内置供应商定义表
 *
 * defaultModel / isDefault 均从模型领域层单一真源派生
 * （DEFAULT_MODEL_BY_KIND / DEFAULT_KIND），避免双源维护。
 */
const BUILTIN_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    kind: 'deepseek',
    displayName: 'DeepSeek',
    defaultModel: DEFAULT_MODEL_BY_KIND.deepseek,
    requiresApiKey: true,
    isDefault: DEFAULT_KIND === 'deepseek',
  },
  {
    kind: 'openai',
    displayName: 'OpenAI',
    defaultModel: DEFAULT_MODEL_BY_KIND.openai,
    requiresApiKey: true,
    isDefault: DEFAULT_KIND === 'openai',
  },
  {
    kind: 'anthropic',
    displayName: 'Anthropic Claude',
    defaultModel: DEFAULT_MODEL_BY_KIND.anthropic,
    requiresApiKey: true,
    isDefault: DEFAULT_KIND === 'anthropic',
  },
  {
    kind: 'ollama',
    displayName: 'Ollama (Local)',
    defaultModel: DEFAULT_MODEL_BY_KIND.ollama,
    requiresApiKey: false,
    isDefault: DEFAULT_KIND === 'ollama',
  },
  {
    kind: 'moonshot',
    displayName: 'Moonshot Kimi',
    defaultModel: DEFAULT_MODEL_BY_KIND.moonshot,
    requiresApiKey: true,
    isDefault: DEFAULT_KIND === 'moonshot',
  },
  {
    kind: 'zhipu',
    displayName: '智谱 GLM',
    defaultModel: DEFAULT_MODEL_BY_KIND.zhipu,
    requiresApiKey: true,
    isDefault: DEFAULT_KIND === 'zhipu',
  },
  {
    kind: 'qwen',
    displayName: '通义千问',
    defaultModel: DEFAULT_MODEL_BY_KIND.qwen,
    requiresApiKey: true,
    isDefault: DEFAULT_KIND === 'qwen',
  },
  {
    kind: 'doubao',
    displayName: '豆包（火山方舟）',
    defaultModel: DEFAULT_MODEL_BY_KIND.doubao,
    requiresApiKey: true,
    isDefault: DEFAULT_KIND === 'doubao',
  },
  {
    kind: 'siliconflow',
    displayName: '硅基流动',
    defaultModel: DEFAULT_MODEL_BY_KIND.siliconflow,
    requiresApiKey: true,
    isDefault: DEFAULT_KIND === 'siliconflow',
  },
  {
    kind: 'openrouter',
    displayName: 'OpenRouter',
    defaultModel: DEFAULT_MODEL_BY_KIND.openrouter,
    requiresApiKey: true,
    isDefault: DEFAULT_KIND === 'openrouter',
  },
];

/**
 * 内置供应商工厂表
 *
 * 每个工厂返回 (modelId) => LanguageModel 的工厂函数。
 * baseURL 单一入口：从 config.providers 读取（config 内部已处理 .env 覆盖），
 * 支持自托管网关 / 代理场景；新增供应商时同步扩展 config 的 ProviderBaseUrlSchema。
 */
const BUILTIN_FACTORIES: Record<ProviderKind, ProviderFactory> = {
  deepseek: ({ apiKey, baseUrl }) => {
    const resolvedBaseUrl = baseUrl ?? getAppConfig().providers.deepseek;
    return createOpenAICompatible({
      name: 'deepseek',
      baseURL: `${resolvedBaseUrl}/v1`,
      // exactOptionalPropertyTypes: apiKey 为 undefined 时不传该字段（ollama 等本地场景）
      ...(apiKey !== undefined ? { apiKey } : {}),
      includeUsage: true,
      // DeepSeek 深度适配（官方文档 https://api-docs.deepseek.com/zh-cn/）：
      // 1. transformRequestBody：思考模式显式开启（v4 默认开启，此处兜底确保语义明确）
      // 2. convertUsage：DeepSeek 非标准 usage 字段（prompt_cache_hit_tokens /
      //    prompt_cache_miss_tokens，KV cache 计费）映射为 AI SDK 标准
      //    inputTokens.cacheRead / noCache
      transformRequestBody: (args) => ({
        ...args,
        // noPropertyAccessFromIndexSignature：Record 类型属性需方括号访问
        ...(args['thinking'] === undefined ? { thinking: { type: 'enabled' as const } } : {}),
      }),
      convertUsage: (usage) => {
        // DeepSeek 非标准 usage 字段（loose schema 透传）：
        // 统一经宽松 Record 方括号访问（snake_case 字段名规避命名规范）
        const raw = usage as Record<string, unknown> | null | undefined;
        const promptDetails = (raw?.['prompt_tokens_details'] ?? {}) as Record<string, unknown>;
        const completionDetails = (raw?.['completion_tokens_details'] ?? {}) as Record<
          string,
          unknown
        >;
        const promptCacheHit =
          (raw?.['prompt_cache_hit_tokens'] as number | undefined) ??
          (promptDetails['cached_tokens'] as number | undefined) ??
          0;
        const promptCacheMiss =
          (raw?.['prompt_cache_miss_tokens'] as number | undefined) ??
          ((raw?.['prompt_tokens'] as number | undefined) ?? 0) - promptCacheHit;
        return {
          inputTokens: {
            total: (raw?.['prompt_tokens'] as number | undefined) ?? 0,
            noCache: promptCacheMiss,
            cacheRead: promptCacheHit,
            // DeepSeek 无 cache write 概念（KV cache 自动构建）
            cacheWrite: 0,
          },
          outputTokens: {
            total: (raw?.['completion_tokens'] as number | undefined) ?? 0,
            text: undefined,
            // null → undefined（LanguageModelV4Usage 不接受 null）
            reasoning: (completionDetails['reasoning_tokens'] as number | undefined) ?? undefined,
          },
        };
      },
    }) as unknown as (modelId: string) => LanguageModel;
  },
  openai: ({ apiKey, baseUrl }) => {
    const resolvedBaseUrl = baseUrl ?? getAppConfig().providers.openai;
    return createOpenAI({
      // exactOptionalPropertyTypes: apiKey 为 undefined 时不传该字段
      ...(apiKey !== undefined ? { apiKey } : {}),
      baseURL: `${resolvedBaseUrl}/v1`,
    }) as unknown as (modelId: string) => LanguageModel;
  },
  anthropic: ({ apiKey, baseUrl }) => {
    const resolvedBaseUrl = baseUrl ?? getAppConfig().providers.anthropic;
    return createAnthropic({
      // exactOptionalPropertyTypes: apiKey 为 undefined 时不传该字段
      ...(apiKey !== undefined ? { apiKey } : {}),
      baseURL: resolvedBaseUrl,
    }) as unknown as (modelId: string) => LanguageModel;
  },
  moonshot: ({ apiKey, baseUrl }) => {
    const resolvedBaseUrl = baseUrl ?? getAppConfig().providers.moonshot;
    return createOpenAICompatible({
      name: 'moonshot',
      baseURL: resolvedBaseUrl,
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
  },
  zhipu: ({ apiKey, baseUrl }) => {
    const resolvedBaseUrl = baseUrl ?? getAppConfig().providers.zhipu;
    return createOpenAICompatible({
      name: 'zhipu',
      baseURL: resolvedBaseUrl,
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
  },
  qwen: ({ apiKey, baseUrl }) => {
    const resolvedBaseUrl = baseUrl ?? getAppConfig().providers.qwen;
    return createOpenAICompatible({
      name: 'qwen',
      baseURL: resolvedBaseUrl,
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
  },
  doubao: ({ apiKey, baseUrl }) => {
    const resolvedBaseUrl = baseUrl ?? getAppConfig().providers.doubao;
    return createOpenAICompatible({
      name: 'doubao',
      baseURL: resolvedBaseUrl,
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
  },
  siliconflow: ({ apiKey, baseUrl }) => {
    const resolvedBaseUrl = baseUrl ?? getAppConfig().providers.siliconflow;
    return createOpenAICompatible({
      name: 'siliconflow',
      baseURL: resolvedBaseUrl,
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
  },
  openrouter: ({ apiKey, baseUrl }) => {
    const resolvedBaseUrl = baseUrl ?? getAppConfig().providers.openrouter;
    return createOpenAICompatible({
      name: 'openrouter',
      baseURL: resolvedBaseUrl,
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
  },
  ollama: ({ baseUrl }) => {
    const resolvedBaseUrl = baseUrl ?? getAppConfig().providers.ollama;
    return createOpenAICompatible({
      name: 'ollama',
      baseURL: `${resolvedBaseUrl}/v1`,
      apiKey: 'ollama',
      includeUsage: false,
    }) as unknown as (modelId: string) => LanguageModel;
  },
};

/**
 * Provider 注册表
 *
 * 无状态：所有供应商定义与工厂均为纯函数/常量。
 * 实例由 ServiceContainer 持有（经 ai-provider.ts 间接使用）。
 */
export class ProviderRegistry {
  private readonly providers: Map<ProviderKind, RegisteredProvider>;

  constructor(definitions: readonly ProviderDefinition[] = BUILTIN_DEFINITIONS) {
    this.providers = new Map();
    for (const definition of definitions) {
      const factory = BUILTIN_FACTORIES[definition.kind];
      if (factory === undefined) {
        throw new Error(`未注册供应商工厂：${definition.kind}`);
      }
      this.providers.set(definition.kind, { definition, factory });
    }
  }

  /**
   * 获取供应商定义
   *
   * @throws Error 未知供应商
   */
  getDefinition(kind: ProviderKind): ProviderDefinition {
    const entry = this.providers.get(kind);
    if (entry === undefined) {
      throw new Error(`未知模型供应商：${kind}`);
    }
    return entry.definition;
  }

  /**
   * 获取默认供应商（isDefault 标记的第一个）
   */
  getDefaultKind(): ProviderKind {
    for (const entry of this.providers.values()) {
      if (entry.definition.isDefault === true) {
        return entry.definition.kind;
      }
    }
    // 无 isDefault 标记时回落到第一个注册的供应商
    const [first] = this.providers.keys();
    if (first === undefined) {
      throw new Error('Provider 注册表为空，无法确定默认供应商');
    }
    return first;
  }

  /**
   * 创建 LanguageModel 工厂
   *
   * @param kind 供应商标识
   * @param context 创建上下文（apiKey / timeout）
   * @returns (modelId) => LanguageModel 工厂函数
   */
  createFactory(
    kind: ProviderKind,
    context: {
      readonly apiKey: string | undefined;
      readonly baseUrl?: string;
    },
  ): (modelId: string) => LanguageModel {
    const entry = this.providers.get(kind);
    if (entry === undefined) {
      throw new Error(`未知模型供应商：${kind}`);
    }
    return entry.factory(context);
  }

  /**
   * 列出所有已注册供应商（供 settings 域 / 设置 UI 展示）
   */
  list(): ProviderInfo[] {
    const defaultKind = this.getDefaultKind();
    const infos: ProviderInfo[] = [];
    for (const { definition } of this.providers.values()) {
      infos.push({
        kind: definition.kind,
        displayName: definition.displayName,
        defaultModel: definition.defaultModel,
        requiresApiKey: definition.requiresApiKey,
        isDefault: definition.kind === defaultKind,
      });
    }
    return infos;
  }
}
