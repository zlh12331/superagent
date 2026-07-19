// src/main/services/embedding.service.ts
// 嵌入向量业务逻辑层
// 设计文档 §4.2 embedding.service / §6.6 Ollama 本地嵌入
//
// 职责：
// 1. embedTexts：批量生成嵌入向量（包装 infra embedding-client，加错误码与用量日志）
// 2. testEmbeddingConnection：Ollama 嵌入服务健康检查（供 settings.testApiKey 使用）
//
// 注意：
// - 向量维度 2048（nemotron-3-embed-1b-bf16），由 infra 层 config 管理
// - 本 service 不做切片，切片在 rag.service 完成
// - 不与其他 service 互相依赖（ai-usage 是共享工具模块，非业务 service）

import { AppError, ErrorCode } from '@novel-writer/shared';
import { getAppConfig } from '../config';
import { embed } from '../infra/ai/embedding-client';
import { logger } from '../utils/logger';
import { logAiUsage } from './ai-usage';

/**
 * 批量生成嵌入向量
 *
 * - 空数组直接返回 []（不发请求）
 * - infra embed 异常统一包装为 AppError(RAG_EMBEDDING_FAILED)
 * - 成功/失败都写用量日志（inputTokens 用文本总字符数估算）
 *
 * @param texts 已切片的文本数组
 * @returns 与输入等长的 2048 维向量数组
 * @throws AppError(RAG_EMBEDDING_FAILED) Ollama 调用失败
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const embedModel = getAppConfig().ollama.embedModel;
  const start = Date.now();

  try {
    const vectors = await embed(texts);

    // 成功用量（token 用字符数估算，嵌入模型无官方 tokenizer 暴露）
    void logAiUsage({
      provider: 'ollama',
      model: embedModel,
      inputTokens: texts.reduce((sum, t) => sum + t.length, 0),
      durationMs: Date.now() - start,
      status: 'ok',
    });

    return vectors;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    void logAiUsage({
      provider: 'ollama',
      model: embedModel,
      durationMs: Date.now() - start,
      status: 'error',
      error: message,
    });

    logger.error({ err: message, count: texts.length }, '嵌入向量生成失败');
    throw new AppError(ErrorCode.RAG_EMBEDDING_FAILED, `嵌入向量生成失败：${message}`);
  }
}

/**
 * 测试 Ollama 嵌入服务连通性
 *
 * 用 embed(['ping']) 做最小化健康检查。
 * 不抛出异常：失败返回 { ok: false }（供 settings.testApiKey 聚合结果）
 */
export async function testEmbeddingConnection(): Promise<{ ok: boolean; latencyMs?: number }> {
  const start = Date.now();

  try {
    await embed(['ping']);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Ollama 嵌入服务连通性检查失败',
    );
    return { ok: false };
  }
}
