// turn-assembly.ts：单回合执行拼装——模型解析 → 流创建（重试+首 part 预读）→ TurnRunner 消费 →
// 工具调用修复接线 → TurnDeps.executeTurn 的真身（机器编排的是它）
import type { ChatMessage } from '@code-agent/shared/main';
import { ModelRetryReason } from '@code-agent/shared/main';
import { randomUUID } from 'node:crypto';
import { isStepCount, streamText } from 'ai';
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
    onRateLimited,
    gateAdmission,
    span,
  } = args;
  const model = await getModel(resolvedModel.modelId);

  let modelTimeout: ReturnType<typeof createTimeoutSignal> | undefined;
  if (resolvedModel.generationConfig?.timeoutMs !== undefined) {
    modelTimeout = createTimeoutSignal(resolvedModel.generationConfig.timeoutMs);
  }
  const effectiveAbortSignal = combineAbortSignals([controller.signal, modelTimeout?.signal]);

  const { compressedMessages, genOptions } = resolveGeneration(systemPrompt ?? '', span);
  let rawParts = 0;

  let runResult: TurnRunResult;
  let usage: SdkTotalUsageLike | null = null;
  let releaseGate: (() => void) | undefined;
  // 逻辑调用 ID：middleware 的 Attempt span 与 telemetry integration 的 model.call 父 span
  // 以同键 join（Attempt 经 providerOptions.codeagent 读，Call 由 streamText telemetry 回调自带）
  const callId = randomUUID();
  try {
    // 尝试级准入：流尝试前等槽位（AbortSignal 取消排队）——acquire 后才算闸内
    if (gateAdmission !== undefined) {
      releaseGate = await gateAdmission.acquire();
    }
    const created = await createStreamWithRetry({
      create: () =>
        streamText({
          model,
          messages: compressedMessages,
          allowSystemInMessages: true,
          ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
          ...genOptions.samplingOptions,
          ...(genOptions.maxOutputTokens !== undefined
            ? { maxOutputTokens: genOptions.maxOutputTokens }
            : {}),
          providerOptions: {
            ...(genOptions.providerOptions ?? {}),
            codeagent: { callId },
          },
          tools: tools as Record<string, never>,
          stopWhen: isStepCount(options.maxSteps),
          maxRetries: resolvedModel.generationConfig?.maxRetries ?? 2,
          ...(effectiveAbortSignal !== undefined ? { abortSignal: effectiveAbortSignal } : {}),
          ...(llmClient !== undefined
            ? {
                repairToolCall: createRepairToolCall({
                  llmClient,
                  modelId: resolvedModel.modelId,
                  ...(effectiveAbortSignal !== undefined ? { signal: effectiveAbortSignal } : {}),
                }),
              }
            : {}),
          telemetry: { integrations: [createSdkTelemetryIntegration()] },
        }),
      controller,
      ...(onRateLimited !== undefined ? { onRateLimited } : {}),
    });

    const runner = new TurnRunner({
      sessionId,
      turnId,
      modelId: resolvedModel.modelId,
      controller,
      emitter: turnEmitter,
      idleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      firstPart: created.firstPart,
      ...(modelTimeout !== undefined
        ? { isTimeout: (): boolean => modelTimeout?.signal.aborted === true }
        : {}),
      onPart: (part) => {
        rawParts += 1;
        if (part.type === 'reasoning-delta' && typeof part.delta === 'string') {
          transcriptEntries.push({ kind: 'reasoning', text: part.delta });
        }
        pushPart(part);
      },
    });
    runResult = await runner.run(created.stream as ReadableStream<unknown>, created.reader);
    usage = await Promise.resolve(created.result.totalUsage).catch(() => null);
    // 尝试级学习信号：runner 正常走完 = 成功（cap streak；限流/错误路径在异常分支上报）
    gateAdmission?.reportOutcome('succeeded');
  } catch (error: unknown) {
    // 失败分类：可重试错误里限流是唯一的 cap 学习信号；其余失败只释放
    if (gateAdmission !== undefined) {
      const appError = classifyModelFailure(error);
      if (appError.retryReason === ModelRetryReason.RateLimited) {
        gateAdmission.reportOutcome('throttled');
      } else if (appError.retryable) {
        gateAdmission.reportOutcome('failed');
      }
    }
    throw error;
  } finally {
    // 计数释放幂等兜底——学习信号先走（throttled/succeeded 已回减），这里防漏减
    releaseGate?.();
    modelTimeout?.clear();
  }

  return {
    reason: runResult.reason,
    durationMs: runResult.durationMs,
    rawPartCount: rawParts,
    usage,
    timeoutSignalAborted: modelTimeout?.signal.aborted === true,
  };
}

export interface TurnRunOutputLike {
  readonly reason: 'completed' | 'aborted' | 'timeout';
  readonly durationMs: number;
  readonly rawPartCount: number;
  readonly usage: unknown;
  readonly timeoutSignalAborted: boolean;
}
