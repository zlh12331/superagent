// registry.ts：供应商注册表——10 家供应商定义（默认模型/API Key 要求）+ SDK 工厂构建
//（openai-compatible 系走 createOpenAICompatible + proxiedFetch，anthropic 用官方 SDK）
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ModelApiFormat } from '@code-agent/shared/main';
import type { LanguageModel } from 'ai';

import { getAppConfig } from '../../../config';
import { proxiedFetch } from '../../network/proxied-fetch';
import { DEFAULT_KIND, DEFAULT_MODEL_BY_KIND } from '../models/builtin-models';
import { defaultApiFormat, resolveProviderBaseUrl } from './endpoint';
import type {
  ProviderCreateContext,
  ProviderDefinition,
  ProviderFactory,
  ProviderInfo,
  ProviderKind,
  RegisteredProvider,
} from './types';

/** 供应商 keychain 键（<kind>-api-key） */
export function toKeychainKey(kind: ProviderKind): string {
  return `${kind}-api-key`;
}

/** 供应商显示名（当前与 kind 同值；展示层再本地化） */
export function getProviderName(kind: ProviderKind): string {
  return kind;
}

// 内置定义：defaultModel 与 requiresApiKey 是设置面表单依据；isDefault 标记全局默认供应商
const BUILTIN_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    kind: 'deepseek',
    defaultModel: DEFAULT_MODEL_BY_KIND.deepseek,
    requiresApiKey: true,
    isDefault: DEFAULT_KIND === 'deepseek',
  },
  {
    kind: 'openai',
    defaultModel: DEFAULT_MODEL_BY_KIND.openai,
    requiresApiKey: true,
    isDefault: DEFAULT_KIND === 'openai',
  },
  {
    kind: 'anthropic',
    defaultModel: DEFAULT_MODEL_BY_KIND.anthropic,
    requiresApiKey: true,
    isDefault: DEFAULT_KIND === 'anthropic',
  },
  {
    kind: 'ollama',
    defaultModel: DEFAULT_MODEL_BY_KIND.ollama,
    requiresApiKey: false,
    isDefault: DEFAULT_KIND === 'ollama',
  },
  {
    kind: 'moonshot',
    defaultModel: DEFAULT_MODEL_BY_KIND.moonshot,
    requiresApiKey: true,
    isDefault: DEFAULT_KIND === 'moonshot',
  },
  {
    kind: 'zhipu',
    defaultModel: DEFAULT_MODEL_BY_KIND.zhipu,
    requiresApiKey: true,
    isDefault: DEFAULT_KIND === 'zhipu',
  },
  {
    kind: 'qwen',
    defaultModel: DEFAULT_MODEL_BY_KIND.qwen,
    requiresApiKey: true,
    isDefault: DEFAULT_KIND === 'qwen',
  },
  {
    kind: 'doubao',
    defaultModel: DEFAULT_MODEL_BY_KIND.doubao,
    requiresApiKey: true,
    isDefault: DEFAULT_KIND === 'doubao',
  },
  {
    kind: 'siliconflow',
    defaultModel: DEFAULT_MODEL_BY_KIND.siliconflow,
    requiresApiKey: true,
    isDefault: DEFAULT_KIND === 'siliconflow',
  },
  {
    kind: 'openrouter',
    defaultModel: DEFAULT_MODEL_BY_KIND.openrouter,
    requiresApiKey: true,
    isDefault: DEFAULT_KIND === 'openrouter',
  },
];

const sdkFetch = { fetch: proxiedFetch as unknown as typeof fetch };

const BUILTIN_FACTORIES: Record<ProviderKind, ProviderFactory> = {
  deepseek: ({ apiKey, baseUrl }) => {
    const resolvedBaseUrl = baseUrl ?? getAppConfig().providers.deepseek;
    return createOpenAICompatible({
      name: 'deepseek',
      baseURL: resolveProviderBaseUrl('deepseek', resolvedBaseUrl),
      ...(apiKey !== undefined ? { apiKey } : {}),
      includeUsage: true,
      ...sdkFetch,
      transformRequestBody: (args) => ({
        ...args,
        ...(args['thinking'] === undefined ? { thinking: { type: 'enabled' as const } } : {}),
      }),
      convertUsage: (usage) => {
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
            cacheWrite: 0,
          },
          outputTokens: {
            total: (raw?.['completion_tokens'] as number | undefined) ?? 0,
            text: undefined,
            reasoning: (completionDetails['reasoning_tokens'] as number | undefined) ?? undefined,
          },
        };
      },
    }) as unknown as (modelId: string) => LanguageModel;
  },
  openai: ({ apiKey, baseUrl }) => {
    const resolvedBaseUrl = baseUrl ?? getAppConfig().providers.openai;
    const provider = createOpenAI({
      ...(apiKey !== undefined ? { apiKey } : {}),
      baseURL: resolveProviderBaseUrl('openai', resolvedBaseUrl),
      ...sdkFetch,
    });
    return provider.chat as unknown as (modelId: string) => LanguageModel;
  },
  anthropic: ({ apiKey, baseUrl }) => {
    const resolvedBaseUrl = baseUrl ?? getAppConfig().providers.anthropic;
    return createAnthropic({
      ...(apiKey !== undefined ? { apiKey } : {}),
      baseURL: resolveProviderBaseUrl('anthropic', resolvedBaseUrl),
      ...sdkFetch,
    }) as unknown as (modelId: string) => LanguageModel;
  },
  moonshot: ({ apiKey, baseUrl }) => {
    const resolvedBaseUrl = baseUrl ?? getAppConfig().providers.moonshot;
    return createOpenAICompatible({
      name: 'moonshot',
      baseURL: resolveProviderBaseUrl('moonshot', resolvedBaseUrl),
      ...(apiKey !== undefined ? { apiKey } : {}),
      includeUsage: true,
      ...sdkFetch,
    });
  },
  zhipu: ({ apiKey, baseUrl }) => {
    const resolvedBaseUrl = baseUrl ?? getAppConfig().providers.zhipu;
    return createOpenAICompatible({
      name: 'zhipu',
      baseURL: resolveProviderBaseUrl('zhipu', resolvedBaseUrl),
      ...(apiKey !== undefined ? { apiKey } : {}),
      includeUsage: true,
      ...sdkFetch,
    });
  },
  qwen: ({ apiKey, baseUrl }) => {
    const resolvedBaseUrl = baseUrl ?? getAppConfig().providers.qwen;
    return createOpenAICompatible({
      name: 'qwen',
      baseURL: resolveProviderBaseUrl('qwen', resolvedBaseUrl),
      ...(apiKey !== undefined ? { apiKey } : {}),
      includeUsage: true,
      ...sdkFetch,
    });
  },
  doubao: ({ apiKey, baseUrl }) => {
    const resolvedBaseUrl = baseUrl ?? getAppConfig().providers.doubao;
    return createOpenAICompatible({
      name: 'doubao',
      baseURL: resolveProviderBaseUrl('doubao', resolvedBaseUrl),
      ...(apiKey !== undefined ? { apiKey } : {}),
      includeUsage: true,
      ...sdkFetch,
    });
  },
  siliconflow: ({ apiKey, baseUrl }) => {
    const resolvedBaseUrl = baseUrl ?? getAppConfig().providers.siliconflow;
    return createOpenAICompatible({
      name: 'siliconflow',
      baseURL: resolveProviderBaseUrl('siliconflow', resolvedBaseUrl),
      ...(apiKey !== undefined ? { apiKey } : {}),
      includeUsage: true,
      ...sdkFetch,
    });
  },
  openrouter: ({ apiKey, baseUrl }) => {
    const resolvedBaseUrl = baseUrl ?? getAppConfig().providers.openrouter;
    return createOpenAICompatible({
      name: 'openrouter',
      baseURL: resolveProviderBaseUrl('openrouter', resolvedBaseUrl),
      ...(apiKey !== undefined ? { apiKey } : {}),
      includeUsage: true,
      ...sdkFetch,
    });
  },
  ollama: ({ baseUrl }) => {
    const resolvedBaseUrl = baseUrl ?? getAppConfig().providers.ollama;
    return createOpenAICompatible({
      name: 'ollama',
      baseURL: resolveProviderBaseUrl('ollama', resolvedBaseUrl),
      apiKey: 'ollama',
      includeUsage: false,
      ...sdkFetch,
    }) as unknown as (modelId: string) => LanguageModel;
  },
};

function createFactoryByFormat(
  kind: ProviderKind,
  apiFormat: ModelApiFormat,
  context: ProviderCreateContext,
): (modelId: string) => LanguageModel {
  const baseUrl = context.baseUrl ?? getAppConfig().providers[kind];
  const apiKey = context.apiKey;

  if (apiFormat === defaultApiFormat(kind)) {
    return BUILTIN_FACTORIES[kind](context);
  }

  if (apiFormat === 'anthropic-messages') {
    const provider = createAnthropic({
      ...(apiKey !== undefined ? { apiKey } : {}),
      baseURL: resolveProviderBaseUrl('anthropic', baseUrl),
      ...sdkFetch,
    });
    return provider as unknown as (modelId: string) => LanguageModel;
  }

  const provider = createOpenAI({
    ...(apiKey !== undefined ? { apiKey } : {}),
    baseURL: resolveProviderBaseUrl(apiFormat === 'openai-responses' ? 'openai' : kind, baseUrl),
    ...sdkFetch,
  });
  return (apiFormat === 'openai-responses' ? provider.responses : provider.chat) as unknown as (
    modelId: string,
  ) => LanguageModel;
}

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

  getDefinition(kind: ProviderKind): ProviderDefinition {
    const entry = this.providers.get(kind);
    if (entry === undefined) {
      throw new Error(`未知模型供应商：${kind}`);
    }
    return entry.definition;
  }

  getDefaultKind(): ProviderKind {
    for (const entry of this.providers.values()) {
      if (entry.definition.isDefault === true) {
        return entry.definition.kind;
      }
    }
    const [first] = this.providers.keys();
    if (first === undefined) {
      throw new Error('Provider 注册表为空，无法确定默认供应商');
    }
    return first;
  }

  createFactory(
    kind: ProviderKind,
    context: {
      readonly apiKey: string | undefined;
      readonly baseUrl?: string;
      readonly apiFormat?: ModelApiFormat;
    },
  ): (modelId: string) => LanguageModel {
    const entry = this.providers.get(kind);
    if (entry === undefined) {
      throw new Error(`未知模型供应商：${kind}`);
    }
    return context.apiFormat !== undefined
      ? createFactoryByFormat(kind, context.apiFormat, context)
      : entry.factory(context);
  }

  list(): ProviderInfo[] {
    const defaultKind = this.getDefaultKind();
    const infos: ProviderInfo[] = [];
    for (const { definition } of this.providers.values()) {
      infos.push({
        kind: definition.kind,
        defaultModel: definition.defaultModel,
        requiresApiKey: definition.requiresApiKey,
        isDefault: definition.kind === defaultKind,
      });
    }
    return infos;
  }
}
