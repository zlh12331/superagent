// src/main/infra/ai/ai-provider.ts
// AI Provider 工厂（多供应商可插拔路由，Code Agent 模板核心）
// ──────────────────────────────────────────────────────────────
// 职责：
// 1. 通过 ProviderRegistry 按 kind 路由到对应供应商（deepseek/openai/anthropic/ollama）
// 2. apiKey 从 keychain 按 kind 独立读取（首次配置时由 settings service 写入）
// 3. provider 实例按 kind 缓存，避免重复创建
// 4. 提供 getModel(kind, modelId) 工厂方法，返回 LanguageModel 实例供 streamText 使用
// 5. 支持 reset（settings:setApiKey 后下次调用重建实例）
// 6. 支持显式 apiKey 注入（用于"测试连接"场景）
//
// 设计（对标 OpenCode provider 路由）：
// - 供应商定义与工厂集中在 providers/ 目录，新增供应商无需改本文件
// - 默认供应商 = registry 中 isDefault 标记（当前 deepseek，保持向后兼容）
// - 各供应商 baseURL 可通过 .env 覆盖（DEEPSEEK_API_BASE / OPENAI_API_BASE /
//   ANTHROPIC_API_BASE / OLLAMA_API_BASE）
// ──────────────────────────────────────────────────────────────

import { AppError, ErrorCode } from '@code-agent/shared';
import type { LanguageModel } from 'ai';
import { logger } from '../../utils/logger';
import { getSecret } from '../storage/keychain';
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
 * 获取指定 model id 的 LanguageModel 实例
 *
 * 便捷封装：先取 provider 工厂，再调工厂方法。
 * 供 streamText / generateText 直接使用。
 *
 * @param modelId 模型 id（省略时使用供应商默认模型）
 * @param options kind 供应商 / apiKey 覆盖（仅用于测试连接）
 */
export async function getModel(
  modelId?: string,
  options?: AiProviderFactoryOptions,
): Promise<LanguageModel> {
  const kind = options?.kind ?? providerRegistry.getDefaultKind();
  const definition = providerRegistry.getDefinition(kind);
  const resolvedModelId = modelId ?? definition.defaultModel;
  const provider = await getAIProvider(options);
  return provider(resolvedModelId);
}

/**
 * 重置 provider 缓存
 *
 * 用于 settings:setApiKey 后下次调用重新创建实例。
 * ServiceContainer.reset() 也会调用此函数。
 */
export function resetAIProvider(): void {
  providerCache.clear();
}

/** 当前缓存的供应商数量（测试断言用） */
export function getProviderCacheSize(): number {
  return providerCache.size;
}
