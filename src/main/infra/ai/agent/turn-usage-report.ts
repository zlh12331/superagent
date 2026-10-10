import type { TurnUsage } from '@code-agent/shared/main';
import { logger } from '../../../utils/logger';
import type { ISessionService } from '../../storage/session-service';

export interface SdkTotalUsageLike {
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly totalTokens: number | undefined;
  readonly inputTokenDetails?: { readonly cacheReadTokens: number | undefined } | undefined;
  readonly outputTokenDetails?: { readonly reasoningTokens: number | undefined } | undefined;
}

export interface TurnUsageReportDeps {
  readonly recordUsage: (
    input: Parameters<ISessionService['recordUsage']>[0],
  ) => ReturnType<ISessionService['recordUsage']>;
  readonly span?:
    | { readonly setAttribute: (key: string, value: number | string) => void }
    | undefined;
}

export function projectTurnUsage(
  usage: SdkTotalUsageLike | null | undefined,
): TurnUsage | undefined {
  if (usage === null || usage === undefined) {
    return undefined;
  }
  return {
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
    ...(usage.inputTokenDetails?.cacheReadTokens !== undefined
      ? { cacheReadTokens: usage.inputTokenDetails.cacheReadTokens }
      : {}),
    ...(usage.outputTokenDetails?.reasoningTokens !== undefined
      ? { reasoningTokens: usage.outputTokenDetails.reasoningTokens }
      : {}),
  };
}

export function reportTurnUsage(
  deps: TurnUsageReportDeps,
  args: {
    readonly sessionId: string;
    readonly modelId: string;
    readonly usage: SdkTotalUsageLike | null | undefined;
  },
): void {
  const { usage } = args;
  if (usage === null || usage === undefined) {
    return;
  }
  logger.info(
    {
      sessionId: args.sessionId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    },
    'Agent token 使用量',
  );
  deps
    .recordUsage({
      sessionId: args.sessionId,
      modelId: args.modelId,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
      reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
    })
    .catch((err: unknown) => {
      logger.error({ error: err }, 'recordUsage 失败');
    });
  if (usage.totalTokens !== undefined) {
    deps.span?.setAttribute('token.total', usage.totalTokens);
  }
  if (usage.inputTokens !== undefined) {
    deps.span?.setAttribute('token.prompt', usage.inputTokens);
  }
  if (usage.outputTokens !== undefined) {
    deps.span?.setAttribute('token.completion', usage.outputTokens);
  }
}
