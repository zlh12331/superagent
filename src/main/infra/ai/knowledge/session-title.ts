// src/main/infra/ai/session-title.ts
// 会话标题生成（agent 回合与 chat 对话共用）
// ──────────────────────────────────────────────────────────────
// 职责：
// - ITitleGenerator：标题生成窄接口（DI 注入，接口隔离）
// - ensureSessionTitle：回合/对话正常结束后异步生成标题（失败静默）
// - firstUserMessageText：从消息历史提取首条 user 文本（生成输入）
//
// 设计：
// - 仅当会话仍为默认标题时执行，不覆盖用户自定义标题
// - 失败静默（logger.debug），不阻断主流程
// ──────────────────────────────────────────────────────────────

import type { ChatMessage } from '@code-agent/shared/main';
import { logger } from '../../../utils/logger';
import type { ISessionService } from '../../storage/session-service';
import { DEFAULT_SESSION_TITLE } from '../../storage/session-service';
import type { LlmGenerateTextOptions, LlmGenerateTextResult } from '../llm-client';

/**
 * 标题生成器接口（DI 窄接口：仅依赖 generateText 能力）
 *
 * LlmClient 结构满足本接口；注入接口而非具体类，便于测试替换。
 */
export interface ITitleGenerator {
  generateText(options: LlmGenerateTextOptions): Promise<LlmGenerateTextResult>;
}

/**
 * 提取首条 user 消息文本（标题生成输入）
 */
export function firstUserMessageText(messages: ChatMessage[]): string | undefined {
  const first = messages.find((m) => m.role === 'user');
  if (first === undefined) {
    return undefined;
  }
  return typeof first.content === 'string' ? first.content : '';
}

/**
 * 提取最后一条 user 消息文本（权限决策：当前回合用户意图，意图豁免破坏性拦截）
 */
export function lastUserMessageText(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return undefined;
}

/**
 * 异步生成会话标题（失败静默，不阻断主流程）
 *
 * 仅当会话仍为默认标题时执行；用首条用户消息生成简洁标题。
 * agent 回合与 chat 对话正常结束后均调用（挂载点统一）。
 */
export async function ensureSessionTitle(params: {
  readonly sessionService: ISessionService;
  readonly titleGenerator: ITitleGenerator;
  readonly sessionId: string;
  readonly firstUserText: string | undefined;
}): Promise<void> {
  try {
    if (params.firstUserText === undefined || params.firstUserText.trim().length === 0) {
      return;
    }
    const detail = await params.sessionService.get(params.sessionId);
    // 会话已有自定义标题：不覆盖
    if (detail.session.title !== DEFAULT_SESSION_TITLE) {
      return;
    }
    const result = await params.titleGenerator.generateText({
      // exactOptionalPropertyTypes：model 省略 = 默认模型
      prompt: `为以下用户消息生成一个简洁的对话标题（20 字以内，不要引号）：\n${params.firstUserText.slice(0, 200)}`,
      maxAttempts: 1,
    });
    const title = result.text.trim().slice(0, 50);
    if (title.length === 0) {
      return;
    }
    await params.sessionService.rename(params.sessionId, title);
    logger.debug({ sessionId: params.sessionId, title }, '会话标题已生成');
  } catch (err: unknown) {
    // 标题生成失败不影响对话（静默）
    logger.debug({ sessionId: params.sessionId, error: err }, '标题生成失败（静默）');
  }
}
