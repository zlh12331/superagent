// agent-service.ts：Agent 服务——回合生命周期总编排（startAgent 入口）：会话抢占 → 事件发布 →
// XState 机器驱动（agent-turn-machine）→ 用量落库/失效广播/标题生成
// 38 号后分工：本类是宿主与装配面，机器是编排者（turn-assembly 拼装回合 deps）
import { randomUUID } from 'node:crypto';
import type {
  AgentStreamEndPayload,
  AgentStreamErrorPayload,
  ChatMessage,
  TurnEndEvent,
  TurnEvent,
  TurnToolResultEvent,
  TurnUsage,
} from '@code-agent/shared/main';
import {
  AppError,
  ErrorCode,
  IPC_DEFINITIONS,
  TurnEventType,
  turnEndInvalidationDomains,
} from '@code-agent/shared/main';
import type { WebContents } from 'electron';
import { emitEvent } from '../../../utils/emit-event';
import { logger } from '../../../utils/logger';
import { broadcastInvalidation } from '../../invalidation/invalidation';
import { readSelectedModelId } from '../../storage/ai-pref';
import type { ISessionService } from '../../storage/session-service';
import { withSpan } from '../../telemetry/otel';
import { TurnEventEmitter } from '../agent-runtime';
import { ActiveSessionRegistry } from '../agent-runtime/active-session-registry';
import { createAgentTurnActor, type TurnDeps } from '../agent-runtime/agent-turn-machine';
import type { ConcurrencyGate } from '../agent-runtime/concurrency-gate';
import type { TurnRunResult } from '../agent-runtime/turn-runner';
import type { TurnTranscriptEntry } from '../agent-runtime/turn-transcript';
import { buildAssistantTurnMessages } from '../agent-runtime/turn-transcript';
import type { ITitleGenerator } from '../knowledge/session-title';
import {
  ensureSessionTitle,
  firstUserMessageText,
  lastUserMessageText,
} from '../knowledge/session-title';
import type { LlmClient } from '../llm-client/llm-client';
import { buildGenerationOptions, modelRegistry } from '../models';
import type { GenerationOptions } from '../models/generation-options';
import type { ResolvedModel } from '../models/types';
import type { IPromptService, ResolvedPrompt } from '../prompt/prompt-service';
import { classifyError } from '../tools/error-classifier';
import type { IPermissionService } from '../tools/permission-service';
import type { Tool, ToolContext } from '../tools/tool';
import type { IToolExecutor } from '../tools/tool-executor';
import type { IToolRegistry } from '../tools/tool-registry';
import { agentAskService } from './agent-ask-service';
import {
  compressByTokenBudget,
  estimateMessagesTokens,
  getCompactionBudget,
  getTokenBudgetDecision,
} from './context-compression';
import { createTurnPartForwarder } from './stream-part-forward';
import { resolveTokenBudgetBasis } from './token-overhead';
import { assembleAndRunTurn } from './turn-assembly';
import {
  subscribeApprovalLifecycle,
  subscribeAskLifecycle,
  subscribeTurnAccumulators,
} from './turn-subscriptions';
import type { SdkTotalUsageLike } from './turn-usage-report';
import { projectTurnUsage, reportTurnUsage } from './turn-usage-report';

/** 启动回合参数：sessionId 缺省则新建；thinking/temperature/modelId 覆盖默认生成配置 */
export interface StartAgentOptions {
  readonly messages: ChatMessage[];
  readonly sessionId: string | undefined;
  readonly workingDir: string;
  readonly systemPrompt: string | undefined;
  readonly resolvedPrompt?: ResolvedPrompt;
  readonly maxSteps: number;
  readonly thinking?: 'off' | 'low' | 'medium' | 'high';
  readonly temperature?: number;
  readonly modelId?: string | undefined;
  readonly mode?: 'plan' | 'build';
  readonly webContents?: WebContents;
}

/** Agent 服务契约（IPC/远程桥/IM 桥/cron/subagent 共同消费） */
export interface IAgentService {
  startAgent(options: StartAgentOptions): Promise<string>;
  abort(sessionId: string): boolean;
  abortAll(): void;
  hasActiveSessions(): boolean;
  dispose(timeoutMs?: number): Promise<void>;
  onTurnEvent(listener: (event: TurnEvent) => void): () => void;
}

/**
 * Agent 服务：8 依赖注入（注册表/执行器/提示词/会话/标题生成器/并发门/权限/LLM 客户端）；
 * 事件订阅经 onTurnEvent（记忆捕获、遥测、通知都挂在这条总线上）
 */
export class AgentService implements IAgentService {
  constructor(
    private readonly toolRegistry: IToolRegistry,
    private readonly toolExecutor: IToolExecutor,
    private readonly promptService: IPromptService,
    private readonly sessionService: ISessionService,
    private readonly titleGenerator?: ITitleGenerator,
    private readonly concurrencyGate?: ConcurrencyGate,
    private readonly permissionService?: IPermissionService,
    private readonly llmClient?: LlmClient,
  ) {}

  private readonly registry = new ActiveSessionRegistry();
  private readonly turnListeners = new Set<(event: TurnEvent) => void>();
  // 同会话并发启动互斥：自旋等上一个 startAgent 走完抢占段（防双流同时登记）
  private readonly startingSessions = new Set<string>();

  onTurnEvent(listener: (event: TurnEvent) => void): () => void {
    this.turnListeners.add(listener);
    return () => {
      this.turnListeners.delete(listener);
    };
  }

  private resolveSystemPrompt(options: StartAgentOptions): Promise<ResolvedPrompt> {
    if (options.resolvedPrompt !== undefined) {
      return Promise.resolve(options.resolvedPrompt);
    }
    return this.promptService.resolvePrompt(undefined, options.workingDir);
  }

  /**
   * 启动回合：抢占同会话旧流 → 标记 running → 后台跑流（不 await，立即返回 sessionId）
   *
   * 流异常只记日志不抛——渲染层靠 TURN_END(error) 事件得知失败
   */
  async startAgent(options: StartAgentOptions): Promise<string> {
    const sessionId = options.sessionId ?? randomUUID();

    while (this.startingSessions.has(sessionId)) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.startingSessions.add(sessionId);

    try {
      await this.registry.preemptExisting(sessionId, 'agent');

      const controller = new AbortController();

      void this.sessionService.markRunning(sessionId).catch((err: unknown) => {
        logger.error({ sessionId, error: err }, 'markRunning 失败');
      });

      const streamPromise = this.runTurnStream(sessionId, options, controller).catch(
        (err: unknown) => {
          logger.error({ sessionId, error: err }, 'AgentService 流推送异常');
        },
      );
      this.registry.register(sessionId, controller, streamPromise);

      streamPromise.finally(() => {
        this.handleStreamSettled(sessionId, streamPromise);
      });

      return sessionId;
    } finally {
      this.startingSessions.delete(sessionId);
    }
  }

  private handleStreamSettled(sessionId: string, streamPromise: Promise<void>): void {
    const isCurrent = this.registry.removeStreamIfCurrent(sessionId, streamPromise);
    if (!isCurrent) {
      return;
    }
    void this.sessionService.markIdle(sessionId).catch((err: unknown) => {
      logger.error({ sessionId, error: err }, 'markIdle 失败');
    });
  }

  abort(sessionId: string): boolean {
    return this.registry.abort(sessionId);
  }

  abortAll(): void {
    this.registry.abortAll();
  }

  hasActiveSessions(): boolean {
    return this.registry.activeCount > 0;
  }

  async dispose(timeoutMs = 3000): Promise<void> {
    await this.registry.dispose(timeoutMs);
  }

  private persistUserMessageQuietly(
    sessionId: string,
    turnId: string,
    options: StartAgentOptions,
  ): void {
    const lastUserMessage = [...options.messages].reverse().find((m) => m.role === 'user');
    if (lastUserMessage === undefined) {
      return;
    }
    try {
      void this.sessionService
        .appendMessage({ sessionId, turnId, messages: [lastUserMessage] })
        .catch((err: unknown) => {
          logger.error({ sessionId, error: err }, '用户消息落库失败');
        });
    } catch (err) {
      logger.error({ sessionId, error: err }, '用户消息落库失败（同步异常）');
    }
  }

  private buildToolExecuteHook(args: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly options: StartAgentOptions;
    readonly turnEmitter: TurnEventEmitter;
    readonly transcriptEntries: TurnTranscriptEntry[];
  }): (tool: Tool, input: unknown, ctx: ToolContext) => Promise<unknown> {
    const { sessionId, turnId, options, turnEmitter, transcriptEntries } = args;
    return async (tool, input, ctx) => {
      const toolStartTime = Date.now();
      const result = await this.toolExecutor.execute(
        tool.name,
        ctx.callId,
        input,
        ctx,
        options.webContents,
      );
      turnEmitter.emit({
        type: TurnEventType.TOOL_RESULT,
        sessionId,
        turnId,
        timestamp: Date.now(),
        toolCallId: ctx.callId,
        toolName: tool.name,
        success: result.error === undefined,
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.error === undefined ? { durationMs: Date.now() - toolStartTime } : {}),
      } satisfies TurnToolResultEvent);
      transcriptEntries.push({
        kind: 'tool-result',
        toolCallId: ctx.callId,
        toolName: tool.name,
        ...(result.error !== undefined ? { error: result.error } : { output: result.output }),
      });
      if (result.error !== undefined) {
        return { error: result.error };
      }
      return result.output;
    };
  }

  private async runTurnStream(
    sessionId: string,
    options: StartAgentOptions,
    controller: AbortController,
  ): Promise<void> {
    const startTime = performance.now();
    await withSpan(
      'agent.streamText',
      {
        'session.id': sessionId,
        'agent.maxSteps': options.maxSteps,
        'agent.hasSystemPrompt': options.systemPrompt !== undefined,
      },
      async (span) => {
        const turnEmitter = new TurnEventEmitter();
        const turnId = randomUUID();
        const turnStartTime = Date.now();
        const forwardTurnEvents = turnEmitter.onAny((event) => {
          for (const listener of this.turnListeners) {
            try {
              listener(event);
            } catch (err: unknown) {
              logger.error({ error: err }, '回合事件转发异常');
            }
          }
        });
        let unsubscribeAll: () => void = () => {};
        let assistantText = '';
        const transcriptEntries: TurnTranscriptEntry[] = [];
        let rawPartCount = 0;
        let releaseGate: (() => void) | undefined;
        let resolvedModel: ResolvedModel | undefined;
        let unsubscribeApproval: (() => void) | undefined;
        let unsubscribeAsk: (() => void) | undefined;
        const partForwarder = createTurnPartForwarder(
          sessionId,
          options.webContents,
          () => resolvedModel?.capabilities.contextWindowSize,
        );

        const deps: TurnDeps = {
          resolveModel: async () => {
            resolvedModel = modelRegistry.resolve(options.modelId ?? readSelectedModelId());
            return resolvedModel.modelId;
          },
          acquireGate: async () => {
            releaseGate =
              this.concurrencyGate === undefined
                ? undefined
                : await this.concurrencyGate.acquire(sessionId, controller.signal);
          },
          executeTurn: async () => {
            const resolved = resolvedModel;
            if (resolved === undefined) {
              throw new Error('回合装配状态缺失（结构上不可达的防御分支）');
            }
            unsubscribeAll = subscribeTurnAccumulators(turnEmitter, {
              onTextDelta: (text) => {
                assistantText += text;
              },
              onToolCall: (entry) => {
                transcriptEntries.push(entry);
              },
            });

            this.persistUserMessageQuietly(sessionId, turnId, options);

            let systemPrompt = options.systemPrompt;
            if (systemPrompt === undefined) {
              const resolvedPrompt = await this.resolveSystemPrompt(options);
              systemPrompt = resolvedPrompt.content;
              logger.debug(
                { sessionId, source: resolvedPrompt.source },
                '已加载默认 Code Agent prompt',
              );
            }

            const userPrompt = lastUserMessageText(options.messages);
            const baseCtx = {
              workingDir: options.workingDir,
              sessionId,
              abortSignal: controller.signal,
              ...(options.webContents !== undefined ? { webContents: options.webContents } : {}),
              mode: options.mode ?? 'build',
              ...(userPrompt !== undefined ? { userPrompt } : {}),
              contextWindowSize: resolved.capabilities.contextWindowSize,
            };
            const tools = this.toolRegistry.toAISDKTools(
              baseCtx,
              this.buildToolExecuteHook({
                sessionId,
                turnId,
                options,
                turnEmitter,
                transcriptEntries,
              }),
            );
            const output = await assembleAndRunTurn({
              sessionId,
              turnId,
              resolvedModel: resolved,
              options,
              controller,
              turnEmitter,
              transcriptEntries,
              pushPart: (part) => {
                rawPartCount += 1;
                partForwarder.push(part);
              },
              resolveGeneration: (prompt, spanRef) =>
                this.resolveTurnGeneration({
                  sessionId,
                  messages: options.messages,
                  thinking: options.thinking,
                  temperature: options.temperature,
                  resolvedModel: resolved,
                  systemPrompt: prompt,
                  span: spanRef as import('@opentelemetry/api').Span | undefined,
                }),
              systemPrompt,
              tools,
              llmClient: this.llmClient,
              span,
            });
            return {
              reason: output.reason,
              durationMs: output.durationMs,
              rawPartCount,
              usage: output.usage,
              timeoutSignalAborted: output.timeoutSignalAborted,
            };
          },
          finalizeCompleted: (output) => {
            partForwarder.flush();
            if (resolvedModel === undefined || output === undefined) {
              logger.error({ sessionId }, 'finalizeCompleted 在非完整装配态被调用');
              return;
            }
            const runResult: TurnRunResult = { reason: 'completed', durationMs: output.durationMs };
            this.finalizeCompletedTurn({
              sessionId,
              turnId,
              resolvedModel,
              runResult,
              usage: output.usage as SdkTotalUsageLike | null,
              turnEmitter,
              options,
              assistantText,
              transcriptEntries,
              span,
            });
          },
          finalizeAborted: (output) => {
            logger.info({ sessionId }, 'Agent 对话被用户中断');
            span?.setAttribute('agent.aborted', true);
            partForwarder.flush();
            this.completeTurn({
              sessionId,
              turnId,
              modelId: resolvedModel?.modelId ?? 'unknown',
              reason: 'aborted',
              durationMs: output?.durationMs ?? Date.now() - turnStartTime,
              emitter: turnEmitter,
              ...(options.webContents !== undefined ? { webContents: options.webContents } : {}),
              assistantText,
              transcriptEntries,
            });
          },
          finalizeError: (error) => {
            partForwarder.flush();
            this.finalizeErrorTurn({
              sessionId,
              turnId,
              modelId: resolvedModel?.modelId ?? 'unknown',
              error: error ?? new Error('回合异常终止（错误对象缺失）'),
              turnStartTime,
              turnEmitter,
              options,
              assistantText,
              transcriptEntries,
            });
          },
          flushForwarder: () => {
            partForwarder.flush();
          },
          releaseGate: () => {
            releaseGate?.();
          },
          clearModelTimeout: () => {},
          cleanup: () => {
            unsubscribeAll();
            forwardTurnEvents();
            unsubscribeApproval?.();
            unsubscribeAsk?.();
            this.registry.removeControllerIfCurrent(sessionId, controller);
            const durationMs = Math.round(performance.now() - startTime);
            logger.info({ sessionId, durationMs }, 'Agent streamText 总耗时');
            span?.setAttribute('agent.durationMs', durationMs);
            span?.end();
          },
          expireApproval: (approvalId) => {
            this.permissionService?.expireApproval(approvalId);
          },
          expireAsk: (askId) => {
            agentAskService.expireAsk(askId);
          },
        };

        const actor = createAgentTurnActor({ sessionId, turnId, deps });
        unsubscribeApproval = subscribeApprovalLifecycle(this.permissionService, sessionId, actor);
        unsubscribeAsk = subscribeAskLifecycle(agentAskService, sessionId, actor);
        const done = new Promise<void>((resolve) => {
          actor.subscribe((snapshot) => {
            if (snapshot.status === 'done') {
              resolve();
            }
          });
        });
        actor.start();
        await done;
      },
    );
  }

  private resolveTurnGeneration(args: {
    readonly sessionId: string;
    readonly messages: ChatMessage[];
    readonly thinking: StartAgentOptions['thinking'];
    readonly temperature: StartAgentOptions['temperature'];
    readonly resolvedModel: ResolvedModel;
    readonly systemPrompt: string;
    readonly span: import('@opentelemetry/api').Span | undefined;
  }): { readonly compressedMessages: ChatMessage[]; readonly genOptions: GenerationOptions } {
    const { sessionId, messages, thinking, temperature, resolvedModel, systemPrompt, span } = args;
    const contextWindowSize = resolvedModel.capabilities.contextWindowSize ?? 128_000;
    const budget = resolveTokenBudgetBasis(contextWindowSize, systemPrompt, this.toolRegistry);
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

  private finalizeCompletedTurn(args: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly resolvedModel: ResolvedModel;
    readonly runResult: TurnRunResult;
    readonly usage: SdkTotalUsageLike | null | undefined;
    readonly turnEmitter: TurnEventEmitter;
    readonly options: StartAgentOptions;
    readonly assistantText: string;
    readonly transcriptEntries: readonly TurnTranscriptEntry[];
    readonly span: import('@opentelemetry/api').Span | undefined;
  }): void {
    const {
      sessionId,
      turnId,
      resolvedModel,
      runResult,
      usage,
      turnEmitter,
      options,
      assistantText,
      transcriptEntries,
      span,
    } = args;
    const turnUsage = projectTurnUsage(usage);
    reportTurnUsage(
      {
        recordUsage: (input) => this.sessionService.recordUsage(input),
        ...(span !== undefined ? { span } : {}),
      },
      { sessionId, modelId: resolvedModel.modelId, usage },
    );

    this.completeTurn({
      sessionId,
      turnId,
      modelId: resolvedModel.modelId,
      reason: 'completed',
      durationMs: runResult.durationMs,
      ...(turnUsage !== undefined ? { usage: turnUsage } : {}),
      emitter: turnEmitter,
      ...(options.webContents !== undefined ? { webContents: options.webContents } : {}),
      assistantText,
      transcriptEntries,
    });
    if (this.titleGenerator !== undefined) {
      void ensureSessionTitle({
        sessionService: this.sessionService,
        titleGenerator: this.titleGenerator,
        sessionId,
        firstUserText: firstUserMessageText(options.messages),
      });
    }
  }

  private finalizeErrorTurn(args: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly modelId: string;
    readonly error: unknown;
    readonly turnStartTime: number;
    readonly turnEmitter: TurnEventEmitter;
    readonly options: StartAgentOptions;
    readonly assistantText: string;
    readonly transcriptEntries: readonly TurnTranscriptEntry[];
  }): void {
    const {
      sessionId,
      turnId,
      modelId,
      error,
      turnStartTime,
      turnEmitter,
      options,
      assistantText,
      transcriptEntries,
    } = args;
    const appError = classifyError(error);
    if (options.webContents !== undefined && !options.webContents.isDestroyed()) {
      const errorPayload: AgentStreamErrorPayload = {
        sessionId,
        code: appError.code,
        message: appError.message,
      };
      emitEvent(options.webContents, IPC_DEFINITIONS.agent.subscribeStreamError, errorPayload);
    }
    turnEmitter.emit({
      type: TurnEventType.ERROR,
      sessionId,
      turnId,
      timestamp: Date.now(),
      code: appError.code,
      message: appError.message,
    } satisfies TurnEvent);
    this.completeTurn({
      sessionId,
      turnId,
      modelId,
      reason: 'error',
      durationMs: Date.now() - turnStartTime,
      emitter: turnEmitter,
      ...(options.webContents !== undefined ? { webContents: options.webContents } : {}),
      assistantText,
      transcriptEntries,
    });
    logger.error({ sessionId, errorCode: appError.code, error: appError }, 'Agent 对话流异常结束');
  }

  private async persistTurn(turn: TurnEndEvent, modelId: string): Promise<void> {
    try {
      await this.sessionService.recordTurn({
        turnId: turn.turnId,
        sessionId: turn.sessionId,
        seq: 0,
        modelId,
        status: turn.reason,
        inputTokens: turn.usage?.inputTokens,
        outputTokens: turn.usage?.outputTokens,
        totalTokens: turn.usage?.totalTokens,
        durationMs: turn.durationMs,
      });
    } catch (err: unknown) {
      logger.error({ sessionId: turn.sessionId, error: err }, 'persistTurn 失败');
    }
  }

  private completeTurn(params: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly modelId: string;
    readonly reason: 'completed' | 'aborted' | 'error';
    readonly durationMs: number;
    readonly usage?: TurnUsage;
    readonly emitter: TurnEventEmitter;
    readonly webContents?: WebContents;
    readonly assistantText?: string;
    readonly transcriptEntries?: readonly TurnTranscriptEntry[];
  }): void {
    const turnEnd: TurnEndEvent = {
      type: TurnEventType.TURN_END,
      sessionId: params.sessionId,
      turnId: params.turnId,
      timestamp: Date.now(),
      reason: params.reason,
      durationMs: params.durationMs,
      ...(params.usage !== undefined ? { usage: params.usage } : {}),
    };
    params.emitter.emit(turnEnd);

    broadcastInvalidation(turnEndInvalidationDomains(params.sessionId), params.sessionId);

    if (
      params.webContents !== undefined &&
      !params.webContents.isDestroyed() &&
      params.reason !== 'error'
    ) {
      const endPayload: AgentStreamEndPayload = {
        sessionId: params.sessionId,
        reason: params.reason,
        ...(params.usage !== undefined ? { usage: params.usage } : {}),
      };
      emitEvent(params.webContents, IPC_DEFINITIONS.agent.subscribeStreamEnd, endPayload);
    }

    void this.persistTurn(turnEnd, params.modelId);

    const turnMessages = buildAssistantTurnMessages(
      params.assistantText ?? '',
      params.transcriptEntries ?? [],
    );
    if (turnMessages.length > 0) {
      try {
        void this.sessionService
          .appendMessage({
            sessionId: params.sessionId,
            turnId: params.turnId,
            messages: turnMessages,
          })
          .catch((err: unknown) => {
            logger.error({ sessionId: params.sessionId, error: err }, '助手消息落库失败');
          });
      } catch (err) {
        logger.error({ sessionId: params.sessionId, error: err }, '助手消息落库失败（同步异常）');
      }
    }
  }
}
