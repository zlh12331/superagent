// src/main/infra/ai/providers/registry.ts
// Provider 注册表（Code Agent 模板核心扩展点）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 集中注册内置供应商（内置 10 家：deepseek/openai/anthropic/ollama/
//   moonshot/zhipu/qwen/doubao/siliconflow/openrouter）
// - 提供按 kind 查找定义与创建 LanguageModel 工厂的入口
// - 提供注册表快照（list，当前生产零调用、仅单测）
//
// 设计（对标 OpenCode 的 provider 路由）：
// - 新增供应商 = 在 BUILTIN_DEFINITIONS 与 BUILTIN_FACTORIES 常量表中各加一条
// - deepseek / ollama / 其余 6 家复用 OpenAI Compatible 协议（@ai-sdk/openai-compatible）
// - openai 使用官方 @ai-sdk/openai，anthropic 使用官方 @ai-sdk/anthropic
// - 每个供应商的 API Key 独立存储（keychain，key 前缀 = kind）
// ──────────────────────────────────────────────────────────────

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ModelApiFormat } from '@code-agent/shared/main';
import type { LanguageModel } from 'ai';

import { getAppConfig } from '../../../config';
import { proxiedFetch } from '../../network/proxied-fetch';
// 单一真源：默认模型 / 默认供应商由模型领域层定义（避免双源维护路由分裂）
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
 * 显示名不在 main 维护：渲染层以 kind 经 i18n（providers.*）解析。
 */
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

/**
 * 端点归一化已收敛至 ./endpoint 单一真源（2026-10-08）
 *
 * 此前本文件私有 trimTrailingSlash / withOpenAiV1，而连通性探测
 * （models.handler.ts 的 buildTestUrl）另有一份不幂等的拼接实现——同一事实
 * 两处各算一遍，用户填 `/v1` 结尾地址时探测 404 拦保存（真实调用反而正确）。
 * 现调用路径与探测路径共用 resolveProviderBaseUrl / resolveProviderRequestUrl。
 */

/**
 * AI SDK fetch 注入（34 号网络代理）
 *
 * 统一传 proxiedFetch：fixed 模式经 ProxyAgent、localhost/bypass 直连、
 * 其余模式零开销直通全局 fetch（proxiedFetch 内部判定）。SDK 在每次请求时
 * 调用该函数——工厂重建（resetAIProvider）+ 此处闭包 = 配置变更免重启生效。
 */
const sdkFetch = { fetch: proxiedFetch as unknown as typeof fetch };

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
      baseURL: resolveProviderBaseUrl('deepseek', resolvedBaseUrl),
      // exactOptionalPropertyTypes: apiKey 为 undefined 时不传该字段（ollama 等本地场景）
      ...(apiKey !== undefined ? { apiKey } : {}),
      includeUsage: true,
      ...sdkFetch,
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
    const provider = createOpenAI({
      // exactOptionalPropertyTypes: apiKey 为 undefined 时不传该字段
      ...(apiKey !== undefined ? { apiKey } : {}),
      baseURL: resolveProviderBaseUrl('openai', resolvedBaseUrl),
      ...sdkFetch,
    });
    // ⚠️ 必须显式 .chat()：@ai-sdk/openai 4.x 的 provider 可调用对象默认返回
    // **Responses API** 模型（`/responses`，见 SDK 类型定义：`(modelId) => OpenAILanguageModel`
    // 实际委托 createResponsesModel），而产品 UI 标注与连通性探测（models:test
    // 的 /chat/completions 请求体）都按 Chat Completions 语义——不显式选 chat
    // 会让真实调用与探测/标注三方分裂（2026-10-08 契约测试实证）
    return provider.chat as unknown as (modelId: string) => LanguageModel;
  },
  anthropic: ({ apiKey, baseUrl }) => {
    const resolvedBaseUrl = baseUrl ?? getAppConfig().providers.anthropic;
    return createAnthropic({
      // exactOptionalPropertyTypes: apiKey 为 undefined 时不传该字段
      ...(apiKey !== undefined ? { apiKey } : {}),
      // 归一化后 SDK 的 normalizeBaseURL 成为无害空转（它只特判官方地址补
      // /v1，输入已归一化时不改变结果）——自建网关原样透传，与探测路径一致
      baseURL: resolveProviderBaseUrl('anthropic', resolvedBaseUrl),
      ...sdkFetch,
    }) as unknown as (modelId: string) => LanguageModel;
  },
  // 以下 6 家 OpenAI-compatible 供应商补 includeUsage:true（2026-09-06 审计修复）：
  // OpenAI 兼容协议流式响应默认不回传 usage，必须带 stream_options.include_usage
  // 才能拿到 token 用量；此前只有 deepseek 开了，导致这 6 家的用量/费用统计
  // 落 0 或缺失（渲染层 usage 面板无法对账）。
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
      // 本地模型不按 token 计费，且 Ollama 的 OpenAI 兼容端点不保证回传 usage
      includeUsage: false,
      ...sdkFetch,
    }) as unknown as (modelId: string) => LanguageModel;
  },
};

/**
 * 按 API 格式创建 LanguageModel 工厂（自定义模型的协议切换入口）
 *
 * 分发规则：
 * - 格式等于该 kind 的原生默认（见 endpoint.ts 的 DEFAULT_API_FORMAT_BY_KIND）
 *   → 走 BUILTIN_FACTORIES（保住各家的深度适配：DeepSeek 的 transformRequestBody
 *     / convertUsage、六家的 includeUsage 等），自定义模型选「默认格式」时与
 *     服务商模式行为完全一致
 * - 用户显式选了非默认格式（如 deepseek kind + openai-responses）→ 用该格式
 *   对应的官方 SDK 接口创建（协议由格式决定，不再套用 kind 的深度适配——
 *     那些适配只对原生协议有意义）
 *
 * 三种格式对应的 SDK 接口（源码实读，勿凭印象改）：
 * - openai-chat → createOpenAICompatible（也可用 createOpenAI().chat；兼容包
 *   对自建网关更宽容，且与六家 kind 的既有路径一致）
 * - openai-responses → createOpenAI().responses
 * - anthropic-messages → createAnthropic
 */
function createFactoryByFormat(
  kind: ProviderKind,
  apiFormat: ModelApiFormat,
  context: ProviderCreateContext,
): (modelId: string) => LanguageModel {
  const baseUrl = context.baseUrl ?? getAppConfig().providers[kind];
  const apiKey = context.apiKey;

  // 格式 = 原生默认：直通 builtin 工厂（保留 kind 特化）
  if (apiFormat === defaultApiFormat(kind)) {
    return BUILTIN_FACTORIES[kind](context);
  }

  if (apiFormat === 'anthropic-messages') {
    const provider = createAnthropic({
      ...(apiKey !== undefined ? { apiKey } : {}),
      baseURL: resolveProviderBaseUrl('anthropic', baseUrl),
      ...sdkFetch,
    });
    // anthropic 的 provider 可调用对象即 messages 模型（无 chat/responses 分叉）
    return provider as unknown as (modelId: string) => LanguageModel;
  }

  // openai-compatible 协议族（chat 与 responses 共用 createOpenAI 的官方实现）
  const provider = createOpenAI({
    ...(apiKey !== undefined ? { apiKey } : {}),
    baseURL: resolveProviderBaseUrl(apiFormat === 'openai-responses' ? 'openai' : kind, baseUrl),
    ...sdkFetch,
  });
  return (apiFormat === 'openai-responses' ? provider.responses : provider.chat) as unknown as (
    modelId: string,
  ) => LanguageModel;
}

/**
 * Provider 注册表
 *
 * 无状态：所有供应商定义与工厂均为纯函数/常量。
 * 模块级单例 providerRegistry 在 providers/index.ts 装配（ai-provider /
 * generation-options 导入；不经 ServiceContainer——provider 层无状态可直用）。
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
   * @param context 创建上下文（apiKey / baseUrl / apiFormat）
   * @returns (modelId) => LanguageModel 工厂函数
   */
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
    // 显式格式（自定义模型）→ 走格式分发；省略 → 走该 kind 的原生工厂
    return context.apiFormat !== undefined
      ? createFactoryByFormat(kind, context.apiFormat, context)
      : entry.factory(context);
  }

  /**
   * 列出所有已注册供应商快照（当前生产零调用、仅单测）
   *
   * 显示名不在快照内：渲染层以 kind 经 i18n（providers.* / providerLabel）
   * 解析，语言包是唯一真源。
   */
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
