// src/main/infra/ai/agent/turn-assembly.ts
// 回合的「装配 + 流消费」：从模型实例到 TurnRunner 统计的一段纯参数化流程
// ──────────────────────────────────────────────────────────────
// 在回合生命周期中的位置：机器（agent-turn-machine）在 running 态经
// deps.executeTurn 调用本模块；本模块返回决策数据（reason/usage/part 计数），
// 由机器 deciding 决策链裁决终态、由宿主三个 finalize 收尾——本模块**不做
// 任何终态判定**（超时/空回复/中断的归因都在机器）。
//
// 六步流程（与提取前的 agent-service.executeTurn 逐行等价）：
//   1. 取 model 实例（ai-provider 单例）
//   2. 建模型级总时长超时信号（与用户中断合并为同一 abort 形态）
//   3. 生成参数与上下文预算（委托宿主 resolveGeneration）
//   4. createStreamWithRetry 创建流（首 part 预读，传输层失败可重试）
//   5. TurnRunner 消费（读流 → 翻译 → 事件产出 → 统计）
//   6. 等 usage（PromiseLike，失败静默置 null）
//
// 为什么独立成模块（38 号 spec 阶段 1）：这约 130 行是纯「参数装配 + 流消费」，
// 与机器控制流、宿主收尾正交；抽出后 agent-service 净行回到 file-size 棘轮门槛内。
//
// 与宿主的职责边界（抽出的取舍，改动前先读）：
// - 订阅装配（subscribeTurnAccumulators）留宿主：累积器（assistantText /
//   transcriptEntries）是收尾闭包持有的状态，跨模块传递徒增接口面
// - 用户消息落库（persistUserMessageQuietly）留宿主：写 DB 是宿主效果
// - 模型级超时定时器的**创建与清理都在本模块**（谁创建谁清理，try/finally）——
//   38 号阶段 2 收尾修复：提取时清理链曾断裂，宿主的 clearModelTimeout
//   沦为对一个从未赋值的变量的 no-op
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
  // 1. 取 model 实例（ai-provider 模块级单例，与 ChatService 同源）
  //    必须传 resolvedModel.modelId 而非 undefined：宿主已按「请求 modelId →
  //    设置 ai.defaultModel → 默认模型」解析出 ResolvedModel，此处若再传
  //    undefined，会二次解析回默认模型，导致「元数据/生成参数取自 A 模型、
  //    实际请求发给 B 模型」的分裂。显式传 id 与宿主解析结果恒等
  //    （resolve 幂等：同 id 再解析返回同一 providerKind / capabilities）
  const model = await getModel(resolvedModel.modelId);

  // 2. 模型级总时长超时（P0-1）：仅当模型配置了 timeoutMs 才创建信号。
  //    数据来源（2026-10-07 接通）：runtime_models.timeout_ms 列（设置页模型
  //    弹窗可配，经 ModelRegistry 与内置 generationConfig 合并）+ 内置模型条目。
  //    未配置时 modelTimeout 仍为 undefined——仅流空闲超时兜底（stream-reader），
  //    与本信号互补：空闲超时管「无字节」，总时长管「有进展但整体跑飞」。
  let modelTimeout: ReturnType<typeof createTimeoutSignal> | undefined;
  if (resolvedModel.generationConfig?.timeoutMs !== undefined) {
    modelTimeout = createTimeoutSignal(resolvedModel.generationConfig.timeoutMs);
  }
  // 合并信号：超时与用户中断折叠为同一 abort 形态（下游 TurnRunner 靠 isTimeout
  // 回调再区分二者——timeout 走错误出口、aborted 走中断出口）
  const effectiveAbortSignal = combineAbortSignals([controller.signal, modelTimeout?.signal]);

  // 3. 生成参数与上下文预算：委托宿主（预算决策/压缩/采样参数解析需要宿主已装配
  //    的 toolRegistry 与日志/遥测）。systemPrompt 为空串时仍传入——宿主内部据此
  //    口径估算固定开销
  const { compressedMessages, genOptions } = resolveGeneration(systemPrompt ?? '', span);
  let rawParts = 0;

  // 4. 创建流 + 消费。try/finally 的意义：模型级超时定时器由本模块创建，
  //    也必须由本模块清理（回合结束即释放，防「长超时 × 高频回合」堆积定时器）。
  let runResult: TurnRunResult;
  let usage: SdkTotalUsageLike | null = null;
  try {
    // 4a. createStreamWithRetry：请求级重试（默认 3 次尝试）**只兜 SDK 覆盖不到的
    //     传输层失败**；HTTP 类错误（429/5xx）已由 streamText 的 model call 级
    //     maxRetries 重试，两层不叠加（否则尝试次数相乘）。首 part 成功后不再重试
    //     ——流中错误重试会重复工具副作用。
    const created = await createStreamWithRetry({
      create: () =>
        streamText({
          model,
          messages: compressedMessages,
          // 允许 messages 中携带 system（本仓消息历史可能含 system 条目）
          allowSystemInMessages: true,
          // 条件展开：exactOptionalPropertyTypes 下可选字段不可显式传 undefined
          ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
          ...genOptions.samplingOptions,
          ...(genOptions.maxOutputTokens !== undefined
            ? { maxOutputTokens: genOptions.maxOutputTokens }
            : {}),
          ...(genOptions.providerOptions !== undefined
            ? { providerOptions: genOptions.providerOptions }
            : {}),
          tools: tools as Record<string, never>,
          // 多轮工具调用上限（AI SDK v7 以 stopWhen 取代旧 maxSteps）
          stopWhen: isStepCount(options.maxSteps),
          // model call 级重试真源：模型配置优先，缺省 2 次重试（= 3 次尝试）
          maxRetries: resolvedModel.generationConfig?.maxRetries ?? 2,
          ...(effectiveAbortSignal !== undefined ? { abortSignal: effectiveAbortSignal } : {}),
          // 工具入参自动修复（SDK v7 repairToolCall 钩子）：LLM 生成非法入参
          // （zod 校验失败）时用轻量 LLM 调用重生成，避免该轮工具调用静默丢弃。
          // 未注入 llmClient 时不挂载（测试/无 side-query 通道场景）
          ...(llmClient !== undefined
            ? {
                repairToolCall: createRepairToolCall({
                  llmClient,
                  modelId: resolvedModel.modelId,
                  ...(effectiveAbortSignal !== undefined ? { signal: effectiveAbortSignal } : {}),
                }),
              }
            : {}),
          // 模型级遥测：在回合 span 之下为每次 LLM 调用自动生成子 span
          // （integration 内部对未初始化 OTel 判空跳过）
          telemetry: { integrations: [createSdkTelemetryIntegration()] },
        }),
      controller,
      // 请求级尝试次数用默认值：与 SDK 的 model call 级重试互不重叠（见 4a 说明）
    });

    // 4b. TurnRunner 消费：读流 → 翻译领域事件 → 产出统计。不感知 webContents/DB
    //     （事件经 emitter 产出，推送由宿主订阅承接）；流空闲超时在 runner 内守卫。
    const runner = new TurnRunner({
      sessionId,
      turnId,
      modelId: resolvedModel.modelId,
      controller,
      emitter: turnEmitter,
      // 空闲超时兜底（600s 无 chunk）：真实可达的超时保护——与模型级超时不同，
      // 这条在缺失 timeoutMs 配置时仍然生效
      idleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      // 首 part 已在 createStreamWithRetry 内预读，runner 接续消费同一 reader
      firstPart: created.firstPart,
      // 超时归因回调：把「超时导致的 abort」与「用户中断」区分开（见第 2 步）
      ...(modelTimeout !== undefined
        ? { isTimeout: (): boolean => modelTimeout?.signal.aborted === true }
        : {}),
      // 原始 part 回调：计数（空回复防护判据）+ 转录 reasoning + 推送给宿主合帧器
      onPart: (part) => {
        rawParts += 1;
        // 思考过程转录（SDK reasoning-delta；工具调用/结果走事件订阅，不在此）
        if (part.type === 'reasoning-delta' && typeof part.delta === 'string') {
          transcriptEntries.push({ kind: 'reasoning', text: part.delta });
        }
        // P2-31：text-delta 进宿主合帧缓冲，其余 part 落地缓冲后立即透传（保序）
        pushPart(part);
      },
    });
    runResult = await runner.run(created.stream as ReadableStream<unknown>, created.reader);
    // 6. 等 usage：totalUsage 是 PromiseLike（流结束后才 resolve），失败静默置 null
    //    （usage 缺失不应让整个回合失败——finalize 侧会按 null 处理）
    usage = await Promise.resolve(created.result.totalUsage).catch(() => null);
  } finally {
    // 模型级超时定时器清理（谁创建谁清理，见第 4 步说明）
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
