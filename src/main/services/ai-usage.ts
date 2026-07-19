// src/main/services/ai-usage.ts
// AI 用量日志模块（ai_usage_logs 表）
// 设计文档 §6.2 AiUsageLog 模型
//
// 职责：
// 1. 统一记录每次 AI 调用（DeepSeek 聊天 / Ollama 嵌入）的 token 与耗时
// 2. 成功（status=ok）与失败（status=error）都记录，用于成本与稳定性分析
//
// 注意：
// - 独立小模块，供 embedding.service / agent.service 复用（避免 service 互相 import）
// - 写日志失败仅 warn，不阻塞业务流程（用量丢失可接受，业务中断不可接受）

import { getPrismaClient } from '../infra/prisma/client';
import { logger } from '../utils/logger';

/** logAiUsage 入参 */
export interface LogAiUsageInput {
  /** 服务商（deepseek / ollama） */
  readonly provider: string;
  /** 模型名（deepseek-v4-flash / nemotron-3-embed-1b-bf16） */
  readonly model: string;
  /** 输入 token 数（估算值，缺省 0） */
  readonly inputTokens?: number;
  /** 输出 token 数（估算值，缺省 0） */
  readonly outputTokens?: number;
  /** 调用耗时（毫秒，缺省 0） */
  readonly durationMs?: number;
  /** 调用结果状态 */
  readonly status: 'ok' | 'error';
  /** 错误消息（status=error 时传入） */
  readonly error?: string;
}

/**
 * 写入 AI 用量日志
 *
 * 失败容错：DB 写入异常时仅 warn 日志，不抛出（不阻塞 AI 业务流程）
 */
export async function logAiUsage(input: LogAiUsageInput): Promise<void> {
  const prisma = getPrismaClient();

  try {
    await prisma.aiUsageLog.create({
      data: {
        provider: input.provider,
        model: input.model,
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        durationMs: input.durationMs ?? 0,
        status: input.status,
        // exactOptionalPropertyTypes：error 仅在传入时写入
        ...(input.error !== undefined ? { error: input.error } : {}),
      },
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'AI 用量日志写入失败（不阻塞业务）',
    );
  }
}
