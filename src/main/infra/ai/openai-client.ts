// src/main/infra/ai/openai-client.ts
// OpenAI 5 SDK 客户端单例（DeepSeek 聊天）
// 设计文档 §2.2 + §4.3 ai/openai-client 职责
//
// 职责：
// 1. 创建 OpenAI 5 SDK 实例，baseURL 指向 DeepSeek API
// 2. apiKey 从 keychain 读取（首次配置时由 settings service 写入）
// 3. 配置默认超时 60s，maxRetries=0（由 retry.ts 统一管理重试）
// 4. 单例缓存，避免重复创建

import { AppError, ErrorCode } from '@novel-writer/shared';
// biome-ignore lint/style/useNamingConvention: OpenAI 是 openai SDK 官方类名
import OpenAI from 'openai';
import { getAppConfig } from '../../config';
import { logger } from '../../utils/logger';
import { getSecret } from '../storage/keychain';

/**
 * OpenAI 客户端单例工厂配置
 */
// biome-ignore lint/style/useNamingConvention: OpenAI 是 openai SDK 官方类名
interface OpenAIClientFactoryOptions {
  /**
   * 显式传入的 API Key（覆盖 keychain 读取）
   *
   * 用于 settings:setApiKey 调用后立即测试连接
   */
  readonly apiKey?: string;
}

/**
 * keychain 中存储 DeepSeek API Key 的 key 名
 */
const DEEPSEEK_API_KEY_NAME = 'deepseek-api-key';

/** 缓存的 OpenAI 实例 */
let cachedClient: OpenAI | null = null;

/**
 * 获取 OpenAI 客户端单例
 *
 * @param options 显式覆盖配置（仅用于 apiKey 测试连接）
 * @returns OpenAI 5 SDK 实例
 * @throws AppError(ErrorCode.AI_API_KEY_MISSING) API Key 未配置
 *
 * @example
 * ```ts
 * const client = await getOpenAIClient();
 * const response = await client.chat.completions.create({
 *   model: 'deepseek-v4-flash',
 *   messages: [{ role: 'user', content: '你好' }],
 * });
 * ```
 */
// biome-ignore lint/style/useNamingConvention: OpenAI 是 openai SDK 官方类名
export async function getOpenAIClient(options?: OpenAIClientFactoryOptions): Promise<OpenAI> {
  // 显式传入 apiKey 时直接创建临时实例（用于测试连接）
  if (options?.apiKey !== undefined) {
    return createClient(options.apiKey);
  }

  // 单例缓存
  if (cachedClient !== null) {
    return cachedClient;
  }

  // 从 keychain 读取 API Key
  const apiKey = await getSecret(DEEPSEEK_API_KEY_NAME);
  if (apiKey === null) {
    throw new AppError(ErrorCode.AI_API_KEY_MISSING, 'DeepSeek API Key 未配置，请先在设置中添加');
  }

  cachedClient = createClient(apiKey);
  logger.info(
    {
      // biome-ignore lint/style/useNamingConvention: baseURL 是 OpenAI SDK 官方字段名
      baseURL: getAppConfig().deepseek.apiBase,
    },
    'OpenAI 客户端已创建',
  );
  return cachedClient;
}

/**
 * 重置客户端缓存
 *
 * 用于 settings:setApiKey 后下次调用重新创建实例
 */
// biome-ignore lint/style/useNamingConvention: OpenAI 是 openai SDK 官方类名
export function resetOpenAIClient(): void {
  cachedClient = null;
}

/**
 * 创建 OpenAI 实例
 */
function createClient(apiKey: string): OpenAI {
  const config = getAppConfig();
  return new OpenAI({
    // biome-ignore lint/style/useNamingConvention: baseURL 是 OpenAI SDK 官方字段名
    baseURL: config.deepseek.apiBase,
    apiKey,
    timeout: config.deepseek.timeout,
    // 重试由 retry.ts 统一管理（含 AppError 分类），SDK 自带重试不区分错误类型
    maxRetries: 0,
  });
}
