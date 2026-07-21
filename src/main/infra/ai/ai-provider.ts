// src/main/infra/ai/ai-provider.ts
// Vercel AI SDK v7 Provider 工厂（DeepSeek 聊天）
// 替换原 openai-client.ts：不再使用 openai SDK，改用 @ai-sdk/openai-compatible
//
// 职责：
// 1. 创建 @ai-sdk/openai-compatible provider 实例（DeepSeek 兼容 OpenAI API）
// 2. apiKey 从 keychain 读取（首次配置时由 settings service 写入）
// 3. 单例缓存，避免重复创建
// 4. 提供 getModel(id) 工厂方法，返回 LanguageModel 实例供 streamText 使用
// 5. 支持 reset（settings:setApiKey 后下次调用重建实例）
// 6. 支持显式 apiKey 注入（用于"测试连接"场景）
//
// 设计文档 §2.2 + §4.3 ai/openai-client 职责（已适配 Vercel AI SDK v7）

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { AppError, ErrorCode } from '@novel-writer/shared';
import type { LanguageModel } from 'ai';
import { getAppConfig } from '../../config';
import { logger } from '../../utils/logger';
import { getSecret } from '../storage/keychain';

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
}

/**
 * keychain 中存储 DeepSeek API Key 的 key 名
 */
const DEEPSEEK_API_KEY_NAME = 'deepseek-api-key';

/**
 * @ai-sdk/openai-compatible provider 类型
 *
 * createOpenAICompatible 返回一个工厂函数，调用 factory(modelId) 返回 LanguageModel
 */
type AiProvider = ReturnType<typeof createOpenAICompatible>;

/** 缓存的 provider 工厂实例 */
let cachedProvider: AiProvider | null = null;

/**
 * 获取 AI Provider 单例
 *
 * 首次调用会从 keychain 读取 API Key 并创建 provider 工厂；
 * 后续调用直接返回缓存实例。
 *
 * @param options 显式覆盖配置（仅用于 apiKey 测试连接）
 * @returns @ai-sdk/openai-compatible provider 工厂
 * @throws AppError(ErrorCode.AI_API_KEY_MISSING) API Key 未配置
 *
 * @example
 * ```ts
 * const provider = await getAIProvider();
 * const model = provider('deepseek-v4-flash');
 * const result = streamText({ model, messages });
 * ```
 */
export async function getAIProvider(options?: AiProviderFactoryOptions): Promise<AiProvider> {
  // 显式传入 apiKey 时直接创建临时实例（用于测试连接），不污染缓存
  if (options?.apiKey !== undefined) {
    return createProvider(options.apiKey);
  }

  // 单例缓存
  if (cachedProvider !== null) {
    return cachedProvider;
  }

  // 从 keychain 读取 API Key
  const apiKey = await getSecret(DEEPSEEK_API_KEY_NAME);
  if (apiKey === null) {
    throw new AppError(ErrorCode.AI_API_KEY_MISSING, 'DeepSeek API Key 未配置，请先在设置中添加');
  }

  cachedProvider = createProvider(apiKey);
  logger.info(
    {
      baseURL: getAppConfig().deepseek.apiBase,
    },
    'AI Provider 已创建',
  );
  return cachedProvider;
}

/**
 * 获取指定 model id 的 LanguageModel 实例
 *
 * 便捷封装：先取 provider，再调工厂方法。
 * 供 streamText / generateText 直接使用。
 *
 * @param modelId 模型 id（如 'deepseek-v4-flash'）
 * @param options 显式 apiKey 覆盖（仅用于测试连接）
 */
export async function getModel(
  modelId: string = getAppConfig().deepseek.model,
  options?: AiProviderFactoryOptions,
): Promise<LanguageModel> {
  const provider = await getAIProvider(options);
  return provider(modelId);
}

/**
 * 重置 provider 缓存
 *
 * 用于 settings:setApiKey 后下次调用重新创建实例。
 * ServiceContainer.reset() 也会调用此函数。
 */
export function resetAIProvider(): void {
  cachedProvider = null;
}

/**
 * 创建 @ai-sdk/openai-compatible provider 工厂实例
 *
 * @param apiKey DeepSeek API Key
 * @returns provider 工厂函数，调用 factory(modelId) 返回 LanguageModel
 */
function createProvider(apiKey: string): AiProvider {
  const config = getAppConfig();
  // DeepSeek API base 不带 /v1，但 @ai-sdk/openai-compatible 要求 baseURL 带 /v1
  // 这里手动拼接，保持 config.deepseek.apiBase 的简洁性
  const baseUrl = `${config.deepseek.apiBase}/v1`;
  return createOpenAICompatible({
    // provider 名称，用于日志和元数据标识
    name: 'deepseek',
    baseURL: baseUrl,
    apiKey,
    // 在流式响应中包含 token usage 信息（用于计费/统计）
    includeUsage: true,
  });
}
