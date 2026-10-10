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

export interface TurnRunOutputLike {
  readonly reason: 'completed' | 'aborted' | 'timeout';
  readonly durationMs: number;
  readonly rawPartCount: number;
  readonly usage: unknown;
  readonly timeoutSignalAborted: boolean;
}
