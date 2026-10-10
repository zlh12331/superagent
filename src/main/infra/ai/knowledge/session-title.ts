// session-title.ts：会话标题生成——首条用户消息喂 LLM 产短标题（agent-service 回合收尾调用）
import type { ChatMessage } from '@code-agent/shared/main';
import { logger } from '../../../utils/logger';
import type { ISessionService } from '../../storage/session-service';
import { DEFAULT_SESSION_TITLE } from '../../storage/session-service';
import type { LlmGenerateTextOptions, LlmGenerateTextResult } from '../llm-client';

/** 标题生成器最小接口（AgentService 只需要 generateText——mock 缝） */
export interface ITitleGenerator {
  generateText(options: LlmGenerateTextOptions): Promise<LlmGenerateTextResult>;
}

export function firstUserMessageText(messages: ChatMessage[]): string | undefined {
  const first = messages.find((m) => m.role === 'user');
  if (first === undefined) {
    return undefined;
  }
  return typeof first.content === 'string' ? first.content : '';
}

export function lastUserMessageText(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return undefined;
}

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
    if (detail.session.title !== DEFAULT_SESSION_TITLE) {
      return;
    }
    const result = await params.titleGenerator.generateText({
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
    logger.debug({ sessionId: params.sessionId, error: err }, '标题生成失败（静默）');
  }
}
