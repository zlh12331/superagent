// ai-provider.ts：AI 供应商装配口——llmClient 单例（依赖 modelRegistry/供应商工厂/模型超时）+
// 供应商工厂缓存 + 运行时模型存储；settings 改 API Key 后 resetAIProvider 重建
import { AppError, ErrorCode } from '@code-agent/shared/main';
import type { LanguageModel } from 'ai';
import { getAppConfig } from '../../../config';
import { logger } from '../../../utils/logger';
import { getSecret } from '../../storage/keychain';
import { modelRegistry } from '../models';
import { RuntimeModelStore } from '../models/runtime-model-store';
import type { ProviderKind } from '../providers';
import { providerRegistry, toKeychainKey } from '../providers';
import { LlmClient } from './';

interface AiProviderFactoryOptions {
  readonly apiKey?: string;
  readonly kind?: ProviderKind;
}

// 工厂按 providerKind 缓存（同一供应商多个模型复用同一份客户端配置）
const providerCache = new Map<string, (modelId: string) => LanguageModel>();

/** 取（或构建）供应商模型工厂；显式 apiKey 直建不缓存（测试/临时探测） */
export async function getAIProvider(
  options?: AiProviderFactoryOptions,
): Promise<(modelId: string) => LanguageModel> {
  const kind = options?.kind ?? providerRegistry.getDefaultKind();
  const definition = providerRegistry.getDefinition(kind);

  if (options?.apiKey !== undefined) {
    return providerRegistry.createFactory(kind, { apiKey: options.apiKey });
  }

  const cached = providerCache.get(kind);
  if (cached !== undefined) {
    return cached;
  }

  let apiKey: string | undefined;
  if (definition.requiresApiKey) {
    const stored = await getSecret(toKeychainKey(kind));
    if (stored === null) {
      throw new AppError(ErrorCode.AI_API_KEY_MISSING, `${kind} API Key 未配置，请先在设置中添加`);
    }
    apiKey = stored;
  }

  const factory = providerRegistry.createFactory(kind, { apiKey });
  providerCache.set(kind, factory);
  logger.info(
    {
      kind,
      model: definition.defaultModel,
    },
    'AI Provider 已创建',
  );
  return factory;
}

/** 限流接缝窄接口：providerKey 定向的冷却两面（喂入 + 等待）——结构化匹配分桶 ConcurrencyGate */
export interface RateLimitGate {
  coolDown(providerKey: string, durationMs: number): void;
  waitCooldown(providerKey: string): Promise<void>;
}

/** 注入的限流闸（ServiceContainer 构造 gate 后调用；未注入时 429 观测不上报、冷却不等待） */
let rateLimitGate: RateLimitGate | undefined;

/**
 * 注入限流闸（ServiceContainer 构造 gate 后调用）。
 *
 * 接缝模式而非直接 import：ai-provider 是模块级单例，直接引容器会造出容器→单例→容器环。
 */
export function setRateLimitBridge(gate: RateLimitGate): void {
  rateLimitGate = gate;
}

async function ensureModelConfigured(): Promise<void> {
  const records = await runtimeModelStore.list();
  if (!records.some((r) => r.isEnabled)) {
    throw new AppError(ErrorCode.AI_MODEL_NOT_CONFIGURED, '请先在设置中配置模型');
  }
  // 冷却等待放在配置检查之后：未配置模型的报错优先于排队等待（排队前先确认能打）。
  // 冷却桶 = 默认 provider（side query 不显式指定模型时都落这里；指定的场景由 runSideQuery
  // 在 getModel 前自行等待）
  await rateLimitGate?.waitCooldown(providerRegistry.getDefaultKind());
}

export const llmClient = new LlmClient({
  modelRegistry,
  defaultTimeoutMs: getAppConfig().modelTimeoutMs,
  createProviderFactory: async (kind, options) => {
    if (
      options?.apiKey !== undefined ||
      options?.baseUrl !== undefined ||
      options?.apiFormat !== undefined
    ) {
      return providerRegistry.createFactory(kind, {
        apiKey: options.apiKey,
        ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
        ...(options.apiFormat !== undefined ? { apiFormat: options.apiFormat } : {}),
      });
    }
    return getAIProvider({ kind });
  },
  modelGate: ensureModelConfigured,
  notifyRateLimited: (durationMs) => {
    rateLimitGate?.coolDown(providerRegistry.getDefaultKind(), durationMs);
  },
});

export const runtimeModelStore = new RuntimeModelStore();

export async function getModel(
  modelId?: string,
  options?: AiProviderFactoryOptions,
): Promise<LanguageModel> {
  if (options?.kind !== undefined || options?.apiKey !== undefined) {
    const kind = options.kind ?? providerRegistry.getDefaultKind();
    const definition = providerRegistry.getDefinition(kind);
    const resolvedModelId = modelId ?? definition.defaultModel;
    const provider = await getAIProvider(options);
    return provider(resolvedModelId);
  }

  return llmClient.getModel(modelId);
}

export function resetAIProvider(): void {
  providerCache.clear();
  llmClient.reset();
}

export function getProviderCacheSize(): number {
  return providerCache.size;
}
