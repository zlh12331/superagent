// src/main/infra/ai/ai-provider.ts
// AI Provider 工厂（多供应商可插拔路由，Code Agent 模板核心）
// ──────────────────────────────────────────────────────────────
// 职责：
// 1. 通过 ProviderRegistry 按 kind 路由到对应供应商（deepseek/openai/anthropic/ollama）
// 2. apiKey 从 keychain 按 kind 独立读取（首次配置时由 settings service 写入）
// 3. provider 实例按 kind 缓存，避免重复创建
// 4. 提供 getModel(modelId) 工厂方法，返回 LanguageModel 实例供 streamText 使用
//    - 无覆盖参数时走 LlmClient（模型级解析：模型 id → 供应商 → per-model 缓存）
//    - 带 kind/apiKey 覆盖时走原 kind 级路由（测试连接 / 显式供应商场景）
// 5. 支持 reset（settings:setApiKey 后下次调用重建实例）
//
// 设计（对标 qwen-code BaseLlmClient + 保持向后兼容）：
// - 模型领域层（models/）：模型条目、ModelRegistry 解析、运行时快照
// - LLM 客户端层（llm-client/）：LlmClient 统一出口（模型级路由 + 缓存 + 重试）
// - 本文件是薄委托层：装配 LlmClient 单例，保持旧 API 签名不变
//   （agent-service / chat-service / service-container 零改动）
// ──────────────────────────────────────────────────────────────

import { AppError, ErrorCode } from '@code-agent/shared/main';
import type { LanguageModel } from 'ai';
import { logger } from '../../utils/logger';
import { getSecret } from '../storage/keychain';
import { LlmClient } from './llm-client';
import { modelRegistry } from './models';
import { RuntimeModelStore } from './models/runtime-model-store';
import type { ProviderKind } from './providers';
import { providerRegistry, toKeychainKey } from './providers';

/**
 * Provider 工厂配置
 */
interface AiProviderFactoryOptions {
  /**
   * 显式传入的 API Key（覆盖 keychain 读取）
   *
   * 用于 settings:setApiKey 后立即测试连接，避免依赖 keychain 缓存
   */
  readonly apiKey?: string;
  /**
   * 目标供应商（默认 registry 的 isDefault 供应商，当前为 deepseek）
   */
  readonly kind?: ProviderKind;
}

/**
 * 缓存的 LanguageModel 工厂（按 kind 缓存）
 */
const providerCache = new Map<string, (modelId: string) => LanguageModel>();

/**
 * 获取指定供应商的 LanguageModel 工厂
 *
 * 首次调用会从 keychain 读取 API Key 并创建 provider；
 * 后续调用直接返回缓存实例。
 *
 * @param options 覆盖配置（apiKey 测试连接 / kind 切换供应商）
 * @returns (modelId) => LanguageModel 工厂
 * @throws AppError(ErrorCode.AI_API_KEY_MISSING) 需要 API Key 的供应商未配置
 *
 * @example
 * ```ts
 * // 默认供应商（deepseek）
 * const provider = await getAIProvider();
 * const model = provider('deepseek-chat');
 *
 * // 指定供应商（anthropic）
 * const anthropicProvider = await getAIProvider({ kind: 'anthropic' });
 * const claude = anthropicProvider('claude-sonnet-4-20250514');
 * ```
 */
export async function getAIProvider(
  options?: AiProviderFactoryOptions,
): Promise<(modelId: string) => LanguageModel> {
  const kind = options?.kind ?? providerRegistry.getDefaultKind();
  const definition = providerRegistry.getDefinition(kind);

  // 显式传入 apiKey 时直接创建临时实例（用于测试连接），不污染缓存
  if (options?.apiKey !== undefined) {
    return providerRegistry.createFactory(kind, { apiKey: options.apiKey });
  }

  // 单例缓存：按 kind 缓存（keychain 中每个 kind 只有一把 key）
  const cached = providerCache.get(kind);
  if (cached !== undefined) {
    return cached;
  }

  // 读取 API Key（本地供应商如 ollama 不需要）
  let apiKey: string | undefined;
  if (definition.requiresApiKey) {
    const stored = await getSecret(toKeychainKey(kind));
    if (stored === null) {
      throw new AppError(
        ErrorCode.AI_API_KEY_MISSING,
        `${definition.displayName} API Key 未配置，请先在设置中添加`,
      );
    }
    apiKey = stored;
  }

  const factory = providerRegistry.createFactory(kind, { apiKey });
  providerCache.set(kind, factory);
  logger.info(
    {
      kind,
      displayName: definition.displayName,
      model: definition.defaultModel,
    },
    'AI Provider 已创建',
  );
  return factory;
}

/**
 * LlmClient 单例（模型级路由统一出口）
 *
 * 依赖装配：
 * - modelRegistry：内置模型注册表（模型 id → 供应商解析）
 * - createProviderFactory：委托 getAIProvider（keychain 读取 + kind 级缓存）
 */
export const llmClient = new LlmClient({
  modelRegistry,
  createProviderFactory: async (kind, options) => {
    // 运行时快照携带显式配置时创建临时实例（不污染 kind 级缓存）
    if (options?.apiKey !== undefined || options?.baseUrl !== undefined) {
      return providerRegistry.createFactory(kind, {
        apiKey: options.apiKey,
        ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      });
    }
    // 常规路径：kind 级缓存 + keychain 读取
    return getAIProvider({ kind });
  },
});

/**
 * 运行时模型存储单例（自定义模型持久化 + 注册）
 *
 * 启动时由 ServiceContainer 调用 loadAll() 加载已保存的模型。
 */
export const runtimeModelStore = new RuntimeModelStore();

/**
 * 获取指定 model id 的 LanguageModel 实例
 *
 * 便捷封装：先取 provider 工厂，再调工厂方法。
 * 供 streamText / generateText 直接使用。
 *
 * ⚠️ 双轨路由（向后兼容设计，语义不同）：
 * - 无覆盖参数（options.kind / apiKey 均为 undefined）：
 *   LlmClient 模型级解析（ModelRegistry）——显式 modelId 跨供应商查找，
 *   未传 modelId 时用默认供应商默认模型（DEFAULT_KIND / DEFAULT_MODEL_BY_KIND）
 * - 带 kind / apiKey 覆盖（⚠️ 仅限 settings 测试连接等临时场景）：
 *   旧 kind 级路由——modelId 直接透传给指定供应商工厂，不做跨供应商解析
 *
 * 调用方注意：业务代码请走无覆盖参数路径；kind/apiKey 覆盖路径
 * 不具备模型级解析/缓存/容错能力，请勿在业务逻辑中使用。
 *
 * @param modelId 模型 id（省略时使用默认模型）
 * @param options kind 供应商 / apiKey 覆盖（仅用于测试连接）
 */
export async function getModel(
  modelId?: string,
  options?: AiProviderFactoryOptions,
): Promise<LanguageModel> {
  // 显式供应商 / API Key 覆盖：走原 kind 级路由（测试连接等临时场景）
  if (options?.kind !== undefined || options?.apiKey !== undefined) {
    const kind = options.kind ?? providerRegistry.getDefaultKind();
    const definition = providerRegistry.getDefinition(kind);
    const resolvedModelId = modelId ?? definition.defaultModel;
    const provider = await getAIProvider(options);
    return provider(resolvedModelId);
  }

  // 常规路径：LlmClient 模型级解析 + per-model 缓存
  return llmClient.getModel(modelId);
}

/**
 * 重置 provider 缓存
 *
 * 用于 settings:setApiKey 后下次调用重新创建实例。
 * ServiceContainer.reset() 也会调用此函数。
 */
export function resetAIProvider(): void {
  providerCache.clear();
  // 同步清空 LlmClient per-model 缓存（模型实例持有旧 API Key）
  llmClient.reset();
}

/** 当前缓存的供应商数量（测试断言用） */
export function getProviderCacheSize(): number {
  return providerCache.size;
}
