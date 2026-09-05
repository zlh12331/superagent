// src/main/infra/ai/agent/turn-usage-report.ts
// 回合 usage 投影 + 遥测上报（自 agent-service.completeTurn 提取）
// ──────────────────────────────────────────────
// 为什么提出来：usage 的条件展开投影 + 日志 + recordUsage + span 打点
// 是一段与回合编排无关的完整块（~55 行），内联会撑爆 completeTurn
// （file-size 净行 600 棘轮）；投影部分是纯函数可独立测试。

import type { TurnUsage } from '@code-agent/shared/main';
import { logger } from '../../../utils/logger';
import type { ISessionService } from '../../storage/session-service';

/**
 * AI SDK totalUsage 的最小结构投影（与 SDK 精确类型解耦，同 StreamPart 哲学）。
 * 可选字段显式 `| undefined`（SDK 源类型即此形态，exactOptionalPropertyTypes
 * 下 `?: number` 与其不兼容）。
 */
export interface SdkTotalUsageLike {
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly totalTokens: number | undefined;
  readonly inputTokenDetails?: { readonly cacheReadTokens: number | undefined } | undefined;
  readonly outputTokenDetails?: { readonly reasoningTokens: number | undefined } | undefined;
}

/** 上报依赖（注入便于测试）；span 用结构最小类型，避免耦合 otel 具体 API */
export interface TurnUsageReportDeps {
  readonly recordUsage: (
    input: Parameters<ISessionService['recordUsage']>[0],
  ) => ReturnType<ISessionService['recordUsage']>;
  readonly span?:
    | { readonly setAttribute: (key: string, value: number | string) => void }
    | undefined;
}

/** SDK usage → 领域 TurnUsage 投影（可选字段条件展开；undefined 透传） */
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

/**
 * 回合 usage 遥测：日志 + 用量持久化（设置页统计）+ span 打点。
 * 持久化失败不阻断主流程；span 打点前逐字段守卫（setAttribute 不接受 undefined）。
 */
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
