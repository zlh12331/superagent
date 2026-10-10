import type { ChatMessage } from '@code-agent/shared/main';
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
import type { StartAgentOptions } from './agent-service';
import { createRepairToolCall } from './repair-tool-call';
import type { SdkTotalUsageLike } from './turn-usage-report';

/**
 * 装配 + 消费入参
 *
 * 宿主闭包状态经此传入，本模块自身无状态（不持有跨调用数据）——所有跨步骤
 * 共享的引用（emitter/累积器/合帧器）都由宿主创建并在此借入。
 */
export interface TurnAssemblyArgs {
  readonly sessionId: string;
  readonly turnId: string;
  readonly resolvedModel: ResolvedModel;
  readonly options: StartAgentOptions;
  readonly controller: AbortController;
  readonly turnEmitter: TurnEventEmitter;
  /** 回合转录累积（宿主数组引用；本模块向其中 push reasoning 条目） */
  readonly transcriptEntries: TurnTranscriptEntry[];
  /** 原始 part 推送（宿主合帧缓冲：text-delta 微批合帧 + 其余透传，P2-31） */
  readonly pushPart: (part: unknown) => void;
  /**
   * 生成参数解析（宿主方法：token 预算决策 / 上下文压缩 / 采样参数）
   *
   * 放在宿主而非本模块的原因：预算决策需要 toolRegistry（固定开销估算）与
   * 日志/遥测，属宿主已装配的依赖面。
   */
  readonly resolveGeneration: (
    systemPrompt: string,
    span: SpanLike,
  ) => {
    readonly compressedMessages: ChatMessage[];
    readonly genOptions: GenerationOptions;
  };
  /** AI SDK 工具集合（宿主 toolRegistry.toAISDKTools 产物，含 executeHook 注入） */
  readonly tools: Record<string, unknown>;
  /** 系统提示词（undefined 时 streamText 不带 system 字段） */
  readonly systemPrompt: string | undefined;
  /** LLM 客户端（仅用于 repairToolCall 工具入参修复；未注入则不挂钩子） */
  readonly llmClient: LlmClient | undefined;
  readonly span: SpanLike;
}

/**
 * OTel Span 的结构子集
 *
 * 只声明本模块用到的 setAttribute——避免为一个可选遥测调用把
 * @opentelemetry/api 的类型依赖引入本模块（宿主传入的 span 结构上兼容）。
 */
export interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): void;
}

/**
 * 装配 streamText 并消费至回合结束
 *
 * 六步流程见文件头。**不做终态判定**：返回值（reason / usage / rawPartCount /
 * timeoutSignalAborted）是原始决策数据，超时/空回复/中断的归因与终态裁决
 * 由机器的 deciding 决策链完成。
 *
 * 失败语义：本模块内部错误直接抛出（由机器 invoke 的 onError 承接）；但
 * 两个「可容忍失败」就地静默——usage 获取失败置 null、流空闲超时由 TurnRunner
 * 归类为 timeout reason。
 *
 * @param args 装配入参（宿主闭包状态；见 TurnAssemblyArgs）
 * @returns 决策数据（reason/durationMs/rawPartCount/usage/timeoutSignalAborted）
 * @throws 装配或流消费的不可容忍错误（机器按 isAbortFailure/error 分流）
 */
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
  try {
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
          ...(genOptions.providerOptions !== undefined
            ? { providerOptions: genOptions.providerOptions }
            : {}),
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
  } finally {
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

/**
 * 消费产物形状（与 agent-turn-machine.TurnRunOutput 结构对齐）
 *
 * 独立声明而非直接 import 机器类型的原因：机器已 import 本模块的
 * TurnAssemblyArgs 等，反向 import 会成循环。两者结构必须手工保持同步
 * ——改动任一方的字段时同步另一方（机器侧字段有 JSDoc 说明各字段用途）。
 */
export interface TurnRunOutputLike {
  readonly reason: 'completed' | 'aborted' | 'timeout';
  readonly durationMs: number;
  readonly rawPartCount: number;
  readonly usage: unknown;
  readonly timeoutSignalAborted: boolean;
}
