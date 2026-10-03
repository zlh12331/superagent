// src/main/infra/ai/agent/turn-assembly.ts
// 回合执行装配与消费（38 号 spec 阶段 1 自 agent-service.executeTurn 提取）
// ──────────────────────────────────────────────────────────────
// 职责：装配（模型实例/超时信号/生成参数/streamText 创建）+ TurnRunner 消费
// + usage 等待 → TurnRunOutput。机器（agent-turn-machine）经 deps.executeTurn
// 在 running 态调用本模块；宿主（agent-service）提供效果依赖。
//
// 提取理由：装配段约 130 行是纯「参数装配 + 流消费」，与回合编排（机器控制流）
// 和收尾（三个 finalize）正交；提取后 agent-service 净行回到棘轮门槛内。
//
// 与宿主的边界：
// - 订阅装配（subscribeTurnAccumulators）留在宿主 deps.executeTurn 前段——
//   累积器（assistantText/transcriptEntries）是收尾闭包的状态，不能跨模块
// - 用户消息落库（persistUserMessageQuietly）留在宿主——写 DB 效果
// ──────────────────────────────────────────────────────────────

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

/** 装配 + 消费入参（宿主闭包状态经此传入；模块保持无状态） */
export interface TurnAssemblyArgs {
  readonly sessionId: string;
  readonly turnId: string;
  readonly resolvedModel: ResolvedModel;
  readonly options: StartAgentOptions;
  readonly controller: AbortController;
  readonly turnEmitter: TurnEventEmitter;
  readonly transcriptEntries: TurnTranscriptEntry[];
  /** 原始 part 推送（合帧缓冲；宿主持有） */
  readonly pushPart: (part: unknown) => void;
  /** 生成参数解析（宿主方法：预算决策/压缩/采样参数） */
  readonly resolveGeneration: (
    systemPrompt: string,
    span: SpanLike,
  ) => {
    readonly compressedMessages: ChatMessage[];
    readonly genOptions: GenerationOptions;
  };
  /** AI SDK 工具集合（宿主 toolRegistry.toAISDKTools 产物） */
  readonly tools: Record<string, unknown>;
  /** 系统提示词（undefined 时 streamText 不传 system 字段） */
  readonly systemPrompt: string | undefined;
  readonly llmClient: LlmClient | undefined;
  readonly span: SpanLike;
}

/** OTel Span 的结构子集（避免本模块依赖 @opentelemetry/api 类型） */
export interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): void;
}

/** 装配 + 消费产物（机器 deciding 决策链与三 finalize 的数据源） */
export interface TurnAssemblyOutput {
  readonly reason: 'completed' | 'aborted' | 'timeout';
  readonly durationMs: number;
  readonly rawPartCount: number;
  readonly usage: SdkTotalUsageLike | null;
  readonly timeoutSignalAborted: boolean;
}

/**
 * 装配 streamText 并消费至回合结束
 *
 * 步骤（与原 agent-service.executeTurn 逐行等价，仅参数化）：
 * 1. 获取 model 实例（ai-provider 单例）
 * 2. 模型级超时信号（P0-1；宿主 deps.clearModelTimeout 消费其 clear）
 * 3. 生成参数与上下文预算（宿主 resolveGeneration）
 * 4. createStreamWithRetry（请求级重试兜传输层失败；SDK maxRetries 管模型调用级）
 * 5. TurnRunner 消费（读流 → 翻译 → 事件产出 → 统计）
 * 6. usage 等待（失败静默置 null）
 *
 * 超时/空回复/中断的归因与收尾不在此处——机器 deciding 决策链按序裁决。
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
  // 1. 获取 model 实例（与 ChatService 一致，复用 ai-provider 单例）
  const model = await getModel(undefined);

  // 2. 模型级容错（P0-1）：总时长超时（信号组合：用户中断 ∪ 模型超时）
  let modelTimeout: ReturnType<typeof createTimeoutSignal> | undefined;
  if (resolvedModel.generationConfig?.timeoutMs !== undefined) {
    modelTimeout = createTimeoutSignal(resolvedModel.generationConfig.timeoutMs);
  }
  const effectiveAbortSignal = combineAbortSignals([controller.signal, modelTimeout?.signal]);

  // 3. 生成参数与上下文预算（预算决策/压缩/采样参数解析在宿主；
  //    systemPrompt 透传给 streamText 的 system 参数）
  const { compressedMessages, genOptions } = resolveGeneration(systemPrompt ?? '', span);
  let rawParts = 0;

  // 4. streamText 创建（请求级重试兜传输层失败；首 part 成功后不重试——
  //    流中错误重试会重复工具副作用）。try/finally：模型级超时定时器谁创建
  //    谁清理（回合结束即释放，防长超时 × 高频调用堆积——38 号阶段 2 收尾
  //    修复：提取时清理链曾断裂，宿主 clearModelTimeout 沦为 no-op）
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
          // model call 级重试真源：模型级 maxRetries（默认 2 次重试 = 3 次尝试）
          maxRetries: resolvedModel.generationConfig?.maxRetries ?? 2,
          ...(effectiveAbortSignal !== undefined ? { abortSignal: effectiveAbortSignal } : {}),
          // 工具入参自动修复（SDK v7 repairToolCall 钩子）：未注入 llmClient 时不启用
          ...(llmClient !== undefined
            ? {
                repairToolCall: createRepairToolCall({
                  llmClient,
                  modelId: resolvedModel.modelId,
                  ...(effectiveAbortSignal !== undefined ? { signal: effectiveAbortSignal } : {}),
                }),
              }
            : {}),
          // 模型级遥测：在回合 span 之下自动生成单次 LLM 调用 span（未初始化 OTel 判空跳过）
          telemetry: { integrations: [createSdkTelemetryIntegration()] },
        }),
      controller,
      // 请求级尝试次数走 createStreamWithRetry 默认值：与 SDK 的 model call
      // 级重试互不重叠（仅兜传输层失败），不再由 maxRetries 换算
    });

    // 5. 回合执行（TurnRunner：读流 → 翻译 → 事件产出 → 统计）
    const runner = new TurnRunner({
      sessionId,
      turnId,
      modelId: resolvedModel.modelId,
      controller,
      emitter: turnEmitter,
      idleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      // 请求级重试链路：首 part 已预读，TurnRunner 接续消费（复用 reader）
      firstPart: created.firstPart,
      // 模型级超时归因：combinedAbortSignals 把超时与用户中断折叠成同一 abort 形态，
      // TurnRunner 借此回调区分二者（timeout 走错误出口，aborted 走中断出口）
      ...(modelTimeout !== undefined
        ? { isTimeout: (): boolean => modelTimeout?.signal.aborted === true }
        : {}),
      // 原始 part 推送（AGENT_STREAM_PART 兼容通道；运行时对象为 SDK 完整 part）
      onPart: (part) => {
        rawParts += 1;
        // 思考过程转录（SDK reasoning-delta；TOOL_* 走事件订阅）
        if (part.type === 'reasoning-delta' && typeof part.delta === 'string') {
          transcriptEntries.push({ kind: 'reasoning', text: part.delta });
        }
        // P2-31：text-delta 进合帧缓冲，其余 part 落地缓冲后立即透传（保序）
        pushPart(part);
      },
    });
    runResult = await runner.run(created.stream as ReadableStream<unknown>, created.reader);
    // usage 等待（totalUsage 是 PromiseLike，流结束后已 resolve；失败静默置 null）
    usage = await Promise.resolve(created.result.totalUsage).catch(() => null);
  } finally {
    // 模型级超时定时器清理：谁创建谁清理（回合结束即释放，防长超时 × 高频调用堆积）
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

/** runTurn 输出形状（与 agent-turn-machine.TurnRunOutput 对齐；避免循环 import） */
export interface TurnRunOutputLike {
  readonly reason: 'completed' | 'aborted' | 'timeout';
  readonly durationMs: number;
  readonly rawPartCount: number;
  readonly usage: unknown;
  readonly timeoutSignalAborted: boolean;
}
