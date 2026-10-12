// turn-assembly.ts：单回合执行拼装——模型解析 → 流创建（重试+首 part 预读）→ TurnRunner 消费 →
// 工具调用修复接线 → TurnDeps.executeTurn 的真身（机器编排的是它）

import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '@code-agent/shared/main';
import { ModelRetryReason } from '@code-agent/shared/main';
import { isStepCount, type LanguageModel, streamText } from 'ai';
import { logger } from '../../../utils/logger';
import { createSdkTelemetryIntegration } from '../../telemetry/sdk-telemetry';
import { combineAbortSignals, createTimeoutSignal } from '../agent-runtime/abort-utils';
import { createStreamWithRetry } from '../agent-runtime/create-stream';
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../agent-runtime/stream-reader';
import type { TurnEventEmitter } from '../agent-runtime/turn-emitter';
import { TurnRunner, type TurnRunResult } from '../agent-runtime/turn-runner';
import type { TurnTranscriptEntry } from '../agent-runtime/turn-transcript';
import { getModel } from '../llm-client/ai-provider';
import type { LlmClient } from '../llm-client/llm-client';
import type { GenerationOptions } from '../models/generation-options';
import type { ResolvedModel } from '../models/types';
import { classifyModelFailure } from '../tools/error-classifier';
import type { StartAgentOptions } from './agent-service';
import { createRepairToolCall } from './repair-tool-call';
import type { SdkTotalUsageLike } from './turn-usage-report';

export interface TurnAssemblyArgs {
  readonly sessionId: string;
  readonly turnId: string;
  readonly resolvedModel: ResolvedModel;
  readonly options: StartAgentOptions;
  readonly controller: AbortController;
  readonly turnEmitter: TurnEventEmitter;
  readonly transcriptEntries: TurnTranscriptEntry[];
  readonly pushPart: (part: unknown) => void;
  readonly resolveGeneration: (
    systemPrompt: string,
    span: SpanLike,
  ) => {
    readonly compressedMessages: ChatMessage[];
    readonly genOptions: GenerationOptions;
  };
  readonly tools: Record<string, unknown>;
  readonly systemPrompt: string | undefined;
  readonly llmClient: LlmClient | undefined;
  /** 已产出的 assistant 部分文本（流恢复锚点的数据源；随 text delta 实时更新） */
  readonly getAssistantPartialText: () => string;
  /** 限流上报：重试观测到 429 时回调（定向本回合 provider 桶冷却） */
  readonly onRateLimited?: (durationMs: number) => void;
  /** 尝试级准入：每次模型流尝试前 acquire（拿票）、终态 release + 学习信号上报（方案 A——
   * 闸约束的是 provider 真实在飞数，退避期不持票）；缺省=无闸直通 */
  readonly gateAdmission?: {
    /** 等待槽位/冷却（AbortSignal 取消排队）；返回 release（幂等） */
    acquire: () => Promise<() => void>;
    /** 尝试终态学习信号：成功计 streak / 限流评价 cap / 其余失败只释放 */
    reportOutcome: (outcome: 'succeeded' | 'throttled' | 'failed') => void;
  };
  readonly span: SpanLike;
}

export interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): void;
}

/** 尝试级准入端口形状（TurnDeps.gateAdmission / RecoveryContext 共用） */
interface GateAdmissionPort {
  acquire(): Promise<() => void>;
  reportOutcome(outcome: 'succeeded' | 'throttled' | 'failed'): void;
}

/** 流恢复独立预算：与首读重试/限流重试互不占用 */
const STREAM_RECOVERY_MAX = 3;

/** 恢复轮的对话锚点：已产出的 assistant 部分文本并入 messages（provider 收到完整上下文）。
 * ⚠ 恢复语义是「追加续写」不是「重答」：assistantText 渲染层/入库继续 += 累积，
 * 恢复指令要求从中断处继续——provider 不遵守时最多出现重复段落，不会丢内容
 * （零协议改动；替换式恢复需要 turn-reset 事件 + 消费面重置，代价不成比例） */
function buildAttemptMessages(ctx: RecoveryContext, streamRecoveryCount: number): ChatMessage[] {
  if (streamRecoveryCount === 0 || ctx.getAssistantPartialText().length === 0) {
    return ctx.compressedMessages;
  }
  return [
    ...ctx.compressedMessages,
    {
      role: 'assistant' as const,
      content: ctx.getAssistantPartialText(),
    },
    {
      role: 'user' as const,
      content:
        '（你上面的回复因连接中断被截断，已有内容用户已收到。请直接从中断处继续输出剩余内容，不要重复已有部分。）',
    },
  ];
}

/** 空补全决策日志（retry / retried-still-empty 两分支共用） */
function logEmptyCompletion(
  sessionId: string,
  turnId: string,
  callId: string,
  decision: 'retry' | 'retried-still-empty',
): void {
  logger.warn(
    { sessionId, turnId, callId },
    decision === 'retry'
      ? '模型空补全（零文本零工具零 part）：重开流重试一次'
      : '空补全重试后仍为空：按原样完成',
  );
}

/** 空补全三态决策：'retry'（首遇空补全，重开流）/ 'retried-still-empty'（重试后仍空，接受完成）/ 'ok'（非空补全） */
function decideEmptyCompletion(
  runResult: TurnRunResult,
  rawParts: number,
  alreadyRetried: boolean,
  getAssistantPartialText: () => string,
): 'retry' | 'retried-still-empty' | 'ok' {
  if (runResult.reason !== 'completed' || rawParts > 0 || getAssistantPartialText().length > 0) {
    return 'ok';
  }
  return alreadyRetried ? 'retried-still-empty' : 'retry';
}

/** 恢复判定：可重试失败 + 已产出部分内容 + 预算未尽 + 未中止 → 允许从对话锚点重开 */
function shouldAttemptRecovery(
  appError: ReturnType<typeof classifyModelFailure>,
  signal: AbortSignal,
  recoveryCount: number,
  getAssistantPartialText: () => string,
): boolean {
  return (
    !signal.aborted &&
    appError.retryable &&
    recoveryCount < STREAM_RECOVERY_MAX &&
    getAssistantPartialText().length > 0
  );
}

/** 失败学习信号分流：rate_limited → throttled（评价 cap）/ 其余可重试 → failed 只释放 */
function reportFailureToGate(
  gate: GateAdmissionPort | undefined,
  appError: ReturnType<typeof classifyModelFailure>,
): void {
  if (gate === undefined) {
    return;
  }
  if (appError.retryReason === ModelRetryReason.RateLimited) {
    gate.reportOutcome('throttled');
  } else if (appError.retryable) {
    gate.reportOutcome('failed');
  }
}

function logRecoveryStart(fields: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly attempt: number;
  readonly max: number;
  readonly discardedChars: number;
  readonly error: unknown;
}): void {
  logger.warn(
    {
      sessionId: fields.sessionId,
      turnId: fields.turnId,
      callId: fields.callId,
      recoveryAttempt: fields.attempt,
      recoveryMax: fields.max,
      discardedChars: fields.discardedChars,
      error: fields.error instanceof Error ? fields.error.message : String(fields.error),
    },
    '流中断恢复：从对话锚点重开',
  );
}

/** streamText 参数装配（create: 闭包的载荷——复杂度热点提取；callId 每轮经重读 latest 拿新值） */
function buildStreamTextParams(parts: {
  readonly model: LanguageModel;
  readonly attemptMessages: ChatMessage[];
  readonly systemPrompt: string | undefined;
  readonly genOptions: GenerationOptions;
  readonly callIdGetter: () => string;
  readonly tools: Record<string, unknown>;
  readonly maxSteps: number;
  readonly maxRetries: number;
  readonly effectiveAbortSignal: AbortSignal | undefined;
  readonly llmClient: LlmClient | undefined;
}): Parameters<typeof streamText>[0] {
  return {
    model: parts.model,
    messages: parts.attemptMessages,
    allowSystemInMessages: true,
    ...(parts.systemPrompt !== undefined ? { system: parts.systemPrompt } : {}),
    ...parts.genOptions.samplingOptions,
    ...(parts.genOptions.maxOutputTokens !== undefined
      ? { maxOutputTokens: parts.genOptions.maxOutputTokens }
      : {}),
    providerOptions: {
      ...(parts.genOptions.providerOptions ?? {}),
      codeagent: { callId: parts.callIdGetter() },
    },
    tools: parts.tools as Record<string, never>,
    stopWhen: isStepCount(parts.maxSteps),
    maxRetries: parts.maxRetries,
    ...(parts.effectiveAbortSignal !== undefined
      ? { abortSignal: parts.effectiveAbortSignal }
      : {}),
    ...(parts.llmClient !== undefined
      ? {
          repairToolCall: createRepairToolCall({
            llmClient: parts.llmClient,
            ...(parts.effectiveAbortSignal !== undefined
              ? { signal: parts.effectiveAbortSignal }
              : {}),
          }),
        }
      : {}),
    telemetry: { integrations: [createSdkTelemetryIntegration()] },
  };
}

export async function assembleAndRunTurn(args: TurnAssemblyArgs): Promise<TurnRunOutputLike> {
  const {
    sessionId,
    turnId,
    resolvedModel,
    options,
    controller,
    turnEmitter,
    transcriptEntries,
    pushPart,
    resolveGeneration,
    systemPrompt,
    tools,
    llmClient,
    getAssistantPartialText,
    onRateLimited,
    gateAdmission,
    span,
  } = args;
  // 模型实例解析（一次捕获，跨恢复尝试复用）：getModel 兼做 providerCache 预热。
  // ⚠️ 不能传字符串 id 给 streamText——字符串经全局 provider 注册表（AI Gateway）
  // 解析而非项目供应商工厂，afa9b534 曾因此把每个回合路由到 Gateway（集成测试抓到）
  const languageModel = await getModel(resolvedModel.modelId);

  const { compressedMessages, genOptions } = resolveGeneration(systemPrompt ?? '', span);
  const rawPartCounter = { count: 0 };

  const recovery = await runRecoveryLoop({
    sessionId,
    turnId,
    resolvedModel,
    model: languageModel,
    options,
    controller,
    turnEmitter,
    transcriptEntries,
    pushPart,
    compressedMessages,
    genOptions,
    systemPrompt,
    tools,
    llmClient,
    getAssistantPartialText,
    onRateLimited,
    gateAdmission,
    span,
    onRawPart: () => {
      rawPartCounter.count += 1;
    },
  });

  return {
    reason: recovery.runResult.reason,
    durationMs: recovery.runResult.durationMs,
    rawPartCount: rawPartCounter.count,
    usage: recovery.usage,
    timeoutSignalAborted: recovery.modelTimeoutAborted,
  };
}

interface RecoveryContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly resolvedModel: ResolvedModel;
  readonly model: LanguageModel;
  readonly options: StartAgentOptions;
  readonly controller: AbortController;
  readonly turnEmitter: TurnEventEmitter;
  readonly transcriptEntries: TurnTranscriptEntry[];
  readonly pushPart: (part: unknown) => void;
  readonly compressedMessages: ChatMessage[];
  readonly genOptions: GenerationOptions;
  readonly systemPrompt: string | undefined;
  readonly tools: Record<string, unknown>;
  readonly llmClient: LlmClient | undefined;
  readonly getAssistantPartialText: () => string;
  readonly onRateLimited: ((durationMs: number) => void) | undefined;
  readonly gateAdmission:
    | {
        acquire(): Promise<() => void>;
        reportOutcome(outcome: 'succeeded' | 'throttled' | 'failed'): void;
      }
    | undefined;
  readonly span: SpanLike;
  readonly onRawPart: () => void;
}

/**
 * 恢复循环（core 级）：边界后断流且可重试时，把已产出的 assistant 部分文本并入对话重开流；
 * 独立预算（STREAM_RECOVERY_MAX），中止/timeout/恢复耗尽后原样上抛。
 */
async function runRecoveryLoop(ctx: RecoveryContext): Promise<{
  runResult: TurnRunResult;
  usage: unknown;
  modelTimeoutAborted: boolean;
}> {
  let runResult: TurnRunResult;
  let usage: SdkTotalUsageLike | null = null;
  let releaseGate: (() => void) | undefined;
  // 逻辑调用 ID：middleware 的 Attempt span 与 telemetry integration 的 model.call 父 span
  // 以同键 join（Attempt 经 providerOptions.codeagent 读，Call 由 streamText telemetry 回调自带）
  let callId = randomUUID();
  let streamRecoveryCount = 0;
  let recoveredDiscardedChars = 0;
  let emptyCompletionRetried = false;
  let modelTimeout: ReturnType<typeof createTimeoutSignal> | undefined;

  try {
    // 恢复循环：正常完成/中止/超时跳出；可重试流错误且预算未尽 → 记账后重开
    for (;;) {
      // 尝试级准入：流尝试前等槽位（AbortSignal 取消排队）——acquire 后才算闸内
      if (ctx.gateAdmission !== undefined) {
        releaseGate = await ctx.gateAdmission.acquire();
      }
      const attemptMessages = buildAttemptMessages(ctx, streamRecoveryCount);

      try {
        callId = randomUUID();
        // 每轮重建模型超时信号（重开流需要新的完整超时窗口）
        const attempt = await runSingleAttempt({ ctx, callId, attemptMessages });
        runResult = attempt.runResult;
        usage = attempt.usage;
        modelTimeout = attempt.modelTimeout;
        // 空补全检测：runner 正常完成但零文本零工具零 part——provider 偶发空流。
        // 空补全专属预算 1（不复用恢复预算）：重开流重试一次，仍空则按原样完成
        const emptyDecision = decideEmptyCompletion(
          attempt.runResult,
          attempt.rawParts,
          emptyCompletionRetried,
          ctx.getAssistantPartialText,
        );
        // 空补全三态：retry 置位后重开；retried-still-empty 接受完成；ok 直通成功收尾
        switch (emptyDecision) {
          case 'retry':
            logEmptyCompletion(ctx.sessionId, ctx.turnId, callId, emptyDecision);
            emptyCompletionRetried = true;
            continue;
          case 'retried-still-empty':
            logEmptyCompletion(ctx.sessionId, ctx.turnId, callId, emptyDecision);
            break;
          default:
            ctx.gateAdmission?.reportOutcome('succeeded');
        }
        break;
      } catch (error: unknown) {
        const appError = classifyModelFailure(error);
        // 失败分类：可重试错误里限流是唯一的 cap 学习信号；其余失败只释放
        reportFailureToGate(ctx.gateAdmission, appError);
        // 恢复判定：可重试失败 + 已产出部分内容 + 预算未尽 + 未中止 → 从对话锚点重开
        if (
          !shouldAttemptRecovery(
            appError,
            ctx.controller.signal,
            streamRecoveryCount,
            ctx.getAssistantPartialText,
          )
        ) {
          throw error;
        }
        streamRecoveryCount += 1;
        recoveredDiscardedChars = ctx.getAssistantPartialText().length;
        logRecoveryStart({
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          callId,
          attempt: streamRecoveryCount,
          max: STREAM_RECOVERY_MAX,
          discardedChars: recoveredDiscardedChars,
          error,
        });
        ctx.span?.setAttribute('stream.recoveryCount', streamRecoveryCount);
        ctx.span?.setAttribute('stream.discardedChars', recoveredDiscardedChars);
      } finally {
        // 计数释放幂等兜底——学习信号先走（throttled/succeeded 已回减），这里防漏减
        releaseGate?.();
        releaseGate = undefined;
      }
    }
  } finally {
    modelTimeout?.clear();
  }

  return {
    runResult,
    usage,
    modelTimeoutAborted: modelTimeout?.signal.aborted === true,
  };
}

/** 单次流尝试：模型超时信号重建 → createStreamWithRetry（首读重试）→ TurnRunner 消费；
 * 错误原样上抛给恢复循环裁决（首 part 经 created.reader 首读，调用方接力消费） */
async function runSingleAttempt(args: {
  readonly ctx: RecoveryContext;
  readonly callId: string;
  readonly attemptMessages: ChatMessage[];
}): Promise<{
  runResult: TurnRunResult;
  usage: SdkTotalUsageLike | null;
  modelTimeout: ReturnType<typeof createTimeoutSignal> | undefined;
  rawParts: number;
}> {
  const { ctx, callId, attemptMessages } = args;
  let attemptRawParts = 0;
  const modelTimeout =
    ctx.resolvedModel.generationConfig?.timeoutMs !== undefined
      ? createTimeoutSignal(ctx.resolvedModel.generationConfig.timeoutMs)
      : undefined;
  const effectiveAbortSignal = combineAbortSignals([ctx.controller.signal, modelTimeout?.signal]);
  const created = await createStreamWithRetry({
    create: () =>
      streamText(
        buildStreamTextParams({
          model: ctx.model,
          attemptMessages,
          systemPrompt: ctx.systemPrompt,
          genOptions: ctx.genOptions,
          callIdGetter: () => callId,
          tools: ctx.tools,
          maxSteps: ctx.options.maxSteps,
          maxRetries: ctx.resolvedModel.generationConfig?.maxRetries ?? 2,
          effectiveAbortSignal,
          llmClient: ctx.llmClient,
        }),
      ),
    controller: ctx.controller,
    ...(ctx.onRateLimited !== undefined ? { onRateLimited: ctx.onRateLimited } : {}),
  });

  // 断流观测出口（core 流恢复拍板的数据源）：
  // preludeBufferedCount>0 = 无感重试窗口真实覆盖过；attemptsToBoundary>1 = 前奏窗口内重建过流
  logger.info(
    {
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      callId,
      preludeBufferedCount: created.preludeBufferedCount,
      attemptsToBoundary: created.attemptsToBoundary,
    },
    '流边界观测',
  );
  ctx.span?.setAttribute('stream.preludeBufferedCount', created.preludeBufferedCount);
  ctx.span?.setAttribute('stream.attemptsToBoundary', created.attemptsToBoundary);

  const runner = new TurnRunner({
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    modelId: ctx.resolvedModel.modelId,
    controller: ctx.controller,
    emitter: ctx.turnEmitter,
    idleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    firstPart: created.firstPart,
    ...(modelTimeout !== undefined
      ? { isTimeout: (): boolean => modelTimeout?.signal.aborted === true }
      : {}),
    onPart: (part) => {
      attemptRawParts += 1;
      ctx.onRawPart();
      if (part.type === 'reasoning-delta' && typeof part.delta === 'string') {
        ctx.transcriptEntries.push({ kind: 'reasoning', text: part.delta });
      }
      ctx.pushPart(part);
    },
  });
  const runResult = await runner.run(created.stream as ReadableStream<unknown>, created.reader);
  const usage = await Promise.resolve(created.result.totalUsage).catch(() => null);
  return { runResult, usage, modelTimeout, rawParts: attemptRawParts };
}

export interface TurnRunOutputLike {
  readonly reason: 'completed' | 'aborted' | 'timeout';
  readonly durationMs: number;
  readonly rawPartCount: number;
  readonly usage: unknown;
  readonly timeoutSignalAborted: boolean;
}
