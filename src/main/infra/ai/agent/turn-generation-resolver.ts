// turn-generation-resolver.ts：回合生成参数解析——上下文预算判定（warn/over-limit 两级）
// + 压缩 + 生成参数组装。从 agent-service 抽出的单一职责模块（该文件净行棘轮压力的解法之一）。
import { AppError, type ChatMessage, ErrorCode } from '@code-agent/shared/main';
import { logger } from '../../../utils/logger';
import type { GenerationOptions } from '../models/generation-options';
import { buildGenerationOptions } from '../models/generation-options';
import type { ResolvedModel } from '../models/types';
import type { IToolRegistry } from '../tools/tool-registry';
import type { StartAgentOptions } from './agent-service';
import {
  compressByTokenBudget,
  estimateMessagesTokens,
  getCompactionBudget,
  getTokenBudgetDecision,
} from './context-compression';
import { resolveTokenBudgetBasis } from './token-overhead';

/** resolveTurnGeneration 入参（toolRegistry 注入——预算基数要统计工具集的系统提示开销） */
export interface TurnGenerationResolverArgs {
  readonly sessionId: string;
  readonly messages: ChatMessage[];
  readonly thinking: StartAgentOptions['thinking'];
  readonly temperature: StartAgentOptions['temperature'];
  readonly resolvedModel: ResolvedModel;
  readonly systemPrompt: string;
  readonly span: import('@opentelemetry/api').Span | undefined;
  readonly toolRegistry: IToolRegistry;
}

/**
 * 解析一回合一的生成输入：上下文预算三级判定（over-limit 抛 AI_CONTEXT_TOO_LARGE 拒绝回合 /
 * warn 记日志打 span）→ 按压缩预算裁剪历史 → 组装采样参数与 token 上限。
 *
 * 抛错语义：over-limit 是回合级拒绝（不是可重试失败），错误码直达渲染层引导精简/新建会话。
 */
export function resolveTurnGeneration(args: TurnGenerationResolverArgs): {
  readonly compressedMessages: ChatMessage[];
  readonly genOptions: GenerationOptions;
} {
  const {
    sessionId,
    messages,
    thinking,
    temperature,
    resolvedModel,
    systemPrompt,
    span,
    toolRegistry,
  } = args;
  const contextWindowSize = resolvedModel.capabilities.contextWindowSize ?? 128_000;
  const budget = resolveTokenBudgetBasis(contextWindowSize, systemPrompt, toolRegistry);
  const contextTokens = estimateMessagesTokens(messages);
  const budgetDecision = getTokenBudgetDecision(contextTokens, budget.effectiveWindow);
  if (budgetDecision.level === 'over-limit') {
    logger.warn(
      {
        sessionId,
        contextTokens: budgetDecision.contextTokens,
        hardLimit: budgetDecision.hardLimit,
      },
      '上下文超出窗口硬上限，回合被拒绝',
    );
    throw new AppError(
      ErrorCode.AI_CONTEXT_TOO_LARGE,
      `上下文超出窗口上限（${budgetDecision.contextTokens} / ${budgetDecision.hardLimit} tokens），请新建会话或精简上下文`,
    );
  }
  if (budgetDecision.level === 'warn') {
    logger.warn(
      {
        sessionId,
        contextTokens: budgetDecision.contextTokens,
        compactAt: budgetDecision.compactAt,
      },
      '上下文接近压缩线（warn）',
    );
    span?.setAttribute('token.contextLevel', 'warn');
  }
  const compactionBudget = getCompactionBudget(budget.effectiveWindow);
  const compressedMessages = compressByTokenBudget(messages, compactionBudget);
  if (compressedMessages.length < messages.length) {
    logger.info(
      {
        originalCount: messages.length,
        compressedCount: compressedMessages.length,
      },
      '上下文已压缩',
    );
  }
  const genOptions = buildGenerationOptions(
    resolvedModel,
    estimateMessagesTokens(compressedMessages) + budget.overheadTokens,
    thinking,
    temperature,
  );
  return { compressedMessages, genOptions };
}
