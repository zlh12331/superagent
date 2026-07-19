// src/main/infra/ai/embedding-client.ts
// 本地 Ollama 嵌入客户端
// 设计文档 §6.6 Ollama 配置 + OpenAI 兼容协议
//
// 复用 openai 5 SDK，baseURL 指向本地 Ollama：
// - URL: http://localhost:11434/v1
// - apiKey: 任意值（Ollama 不校验）
// - 模型: nemotron-3-embed-1b-bf16（2048 维）
//
// Ollama 提供 OpenAI 兼容的 /v1/embeddings 端点，可直接复用 openai SDK

// biome-ignore lint/style/useNamingConvention: OpenAI 是 openai SDK 官方类名
import OpenAI from 'openai';
import { getAppConfig } from '../../config';
import { logger } from '../../utils/logger';

/**
 * Ollama 不校验 API Key，任意值即可
 */
const OLLAMA_API_KEY = 'ollama';

/**
 * OpenAI SDK 兼容路径（Ollama 在 /v1 下提供 OpenAI 兼容 API）
 */
const OLLAMA_API_PATH = '/v1';

/** 缓存的 embedding 客户端 */
let cachedClient: OpenAI | null = null;

/**
 * 获取嵌入客户端单例
 *
 * @returns 指向本地 Ollama 的 OpenAI SDK 实例
 *
 * @example
 * ```ts
 * const client = getEmbeddingClient();
 * const res = await client.embeddings.create({
 *   model: 'nemotron-3-embed-1b-bf16',
 *   input: ['你好'],
 * });
 * ```
 */
export function getEmbeddingClient(): OpenAI {
  if (cachedClient !== null) {
    return cachedClient;
  }

  const config = getAppConfig();
  // biome-ignore lint/style/useNamingConvention: baseURL 是 OpenAI SDK 官方字段名
  const baseURL = `${config.ollama.url}${OLLAMA_API_PATH}`;

  cachedClient = new OpenAI({
    // biome-ignore lint/style/useNamingConvention: baseURL 是 OpenAI SDK 官方字段名
    baseURL,
    apiKey: OLLAMA_API_KEY,
    // 重试由 retry.ts 统一管理（含 AppError 分类）
    maxRetries: 0,
  });

  logger.info(
    {
      // biome-ignore lint/style/useNamingConvention: baseURL 是 OpenAI SDK 官方字段名
      baseURL,
      model: config.ollama.embedModel,
    },
    'Ollama 嵌入客户端已创建',
  );
  return cachedClient;
}

/**
 * 重置 embedding 客户端缓存
 *
 * 用于配置变更后重新创建实例
 */
export function resetEmbeddingClient(): void {
  cachedClient = null;
}

/**
 * 批量生成嵌入向量
 *
 * @param texts 文本数组（已切片）
 * @returns 与输入等长的向量数组（每个元素是 number[]）
 *
 * @example
 * ```ts
 * const vectors = await embed(['你好', '世界']);
 * // vectors = [[0.1, 0.2, ...], [0.3, 0.4, ...]]
 * ```
 */
export async function embed(texts: string[]): Promise<number[][]> {
  // 空数组直接返回，避免无效请求
  if (texts.length === 0) {
    return [];
  }

  const config = getAppConfig();
  const client = getEmbeddingClient();

  const response = await client.embeddings.create({
    model: config.ollama.embedModel,
    input: texts,
  });

  logger.debug({ count: texts.length, model: config.ollama.embedModel }, '嵌入向量生成完成');

  // OpenAI SDK 返回的 data 数组顺序与 input 一一对应
  return response.data.map((item: { embedding: number[] }) => item.embedding);
}
