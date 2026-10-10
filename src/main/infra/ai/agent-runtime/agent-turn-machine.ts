import { APPROVAL_TIMEOUT_MS, AppError, ASK_TIMEOUT_MS, ErrorCode } from '@code-agent/shared/main';
import { assign, createActor, fromPromise, setup } from 'xstate';
import { isAbortError } from '../tools/error-classifier';
import type { ApprovalDecisionOutcome } from '../tools/permission-types';
/** runTurn 输出（deciding 决策链与收尾的数据源） */
export interface TurnRunOutput {
  readonly reason: 'completed' | 'aborted' | 'timeout';
  readonly durationMs: number;
  /** 原始 part 计数（空回复防护判据：completed 且 0 → AI_EMPTY_RESPONSE） */
  readonly rawPartCount: number;
  /** SDK totalUsage 原值（PromiseLike resolve 结果；投影归宿主 finalize） */
  readonly usage: unknown;
  /** 模型级超时信号是否已触发（completed 形态超时竞态的归因判据） */
  readonly timeoutSignalAborted: boolean;
}

/**
 * 宿主效果注入（纯函数签名，agent-service 提供实现）
 *
 * 机器 = 控制流权威，宿主 = 效果提供者——实现侧闭包持有 webContents/DB/
 * 累积器/span 等真实依赖，机器不感知。三个 finalize 对应原三出口
 * （finalizeCompletedTurn / completeTurn(aborted) / finalizeErrorTurn）。
 */
export interface TurnDeps {
  /** 解析当前模型（轻量；失败 → error，不进并发队列） */
  resolveModel(): Promise<string>;
  /** 获取并发槽位（FIFO 排队；排队期 abort 以 AbortError 拒绝） */
  acquireGate(): Promise<void>;
  /** 回合执行：重装配 + streamText 创建 + TurnRunner 消费 + usage 等待 */
  executeTurn(): Promise<TurnRunOutput>;
  /** 完成收尾（usage 投影 / END 推送 / Transcript 落库 / 标题生成） */
  finalizeCompleted(output: TurnRunOutput | undefined): void;
  /** 中断收尾（END(aborted) 推送 / Transcript 落库） */
  finalizeAborted(output: TurnRunOutput | undefined): void;
  /** 错误收尾（error 为 undefined 时表示宿主内部兜底——按未知错误分类） */
  finalizeError(error: unknown): void;
  /** 合帧缓冲落地（幂等；装配失败时允许 no-op） */
  flushForwarder(): void;
  /** running 退出·槽位释放（幂等；未排队时 no-op；须先于 clearModelTimeout） */
  releaseGate(): void;
  /** running 退出·模型超时定时器清理（幂等）。
   * 宿主当前实现为显式 no-op：定时器的创建与清理已移至 turn-assembly
   * （谁创建谁清理，try/finally 内闭环）；保留本 dep 是为不动机器契约
   * （running.exit 引用它）与 exit 顺序测试——若要移除，需同步改
   * TurnDeps/action/exit 与顺序测试（跨模块，另行处理） */
  clearModelTimeout(): void;
  /** 终态清理：订阅退订 + registry CAS + 耗时日志 + span.end（幂等） */
  cleanup(): void;
  /**
   * 审批超时到期（机器 after 转换调用）：让 permission-service 以「超时」语义
   * 拒绝该 pending（区别于用户拒绝 resolve(false)——错误码/文案不同）。
   * ⚠️ 38 号阶段 2 收尾：审批超时计时源从 permission-service 的 setTimeout
   * 迁移至机器 after（声明式、随状态退出自动取消，消除三处手工 clearTimeout）；
   * 该契约成立的前提是 requestApproval 的带 webContents 分支只经 agent 回合
   * 的 executeHook 到达（ToolExecutor.execute 唯一调用方是 agent-service）。
   */
  expireApproval(approvalId: string): void;
  /**
   * 提问超时到期（机器 after 转换调用，38 号阶段 2 收尾）：让 agent-ask-service
   * 以「未响应」语义 resolve(null)（工具据此返回让 LLM 继续）。
   * 前提同 expireApproval：ask 只经 agent 回合的 ToolExecutor 到达。
   */
  expireAsk(askId: string): void;
}

/** 回合上下文（deps 注入 + 决策产物；字段在 actions 内 assign） */
export interface AgentTurnContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly startedAt: number;
  readonly deps: TurnDeps;
  /** 当前模型 id（resolving 完成后赋值；解析失败时缺省，finalize 以 'unknown' 兜底） */
  modelId?: string;
  /** runTurn 输出（deciding 入口 stash；三 finalize 消费） */
  runOutput?: TurnRunOutput;
  /** 错误对象（error 终态收尾消费；超时/空回复在 deciding 内构造 AppError） */
  error?: unknown;
  /** 最后一次审批决策（38 号阶段 2：waitingApproval 出口语义显式化；快照审计用） */
  approvalDecision?: ApprovalDecisionOutcome;
  /**
   * 当前等待中的审批 id 列表（approval.requested 累加；responded 逐个移除）
   *
   * 一轮模型回复可含多个 ask 工具调用（AI SDK 并行执行），故为列表而非单值——
   * 全部决出（或一起超时）才退出 waitingApproval（2026-10-08 并行审批修复）。
   */
  pendingApprovalIds: readonly string[];
  /** 审批超时毫秒（input 注入；默认 shared APPROVAL_TIMEOUT_MS，测试可缩短） */
  readonly approvalTimeoutMs: number;
  /**
   * 当前等待中的提问 id 列表（ask.requested 累加；responded 逐个移除）
   *
   * 与 pendingApprovalIds 同构：一轮可含多个 ask 工具调用（AI SDK 并行执行），
   * 全部决出（或一起超时）才退出 waitingInput（2026-10-08 并行修复）。
   */
  pendingAskIds: readonly string[];
  /** 提问超时毫秒（input 注入；默认 shared ASK_TIMEOUT_MS，测试可缩短） */
  readonly askTimeoutMs: number;
  /** 最后一次提问决策（waitingInput 出口语义显式化；快照审计用） */
  askDecision?: 'answered' | 'timed-out';
}

/** 机器事件（可辨识联合；send 类型不匹配编译期报错）。
 * xstate.error.actor.* 为 v5.19+ 通配符写法：invoke onError 的平台错误事件
 * （{ type, error }）经此进入类型系统，guard/assign 可窄化读取 error 字段 */
export type TurnMachineEvent =
  | { readonly type: 'approval.requested'; readonly approvalId: string }
  | {
      readonly type: 'approval.responded';
      /**
       * 决出的审批 id（并行审批必需：一次回合可有多条待决，responded 需指明
       * 是哪一条——否则无法判断"是否还有其它待决"与退出时机）
       */
      readonly approvalId: string;
      readonly decision: ApprovalDecisionOutcome;
    }
  | { readonly type: 'ask.requested'; readonly askId: string }
  | {
      readonly type: 'ask.responded';
      /** 决出的提问 id（并行提问必需：说明"哪一条已答"以判断是否还有待决） */
      readonly askId: string;
      readonly decision: 'answered' | 'timed-out';
    }
  | { readonly type: 'xstate.error.actor.*'; readonly error: unknown };

/** 回合状态字面量联合（快照 value 形态；running 为层级嵌套） */
export type AgentTurnState =
  | 'resolving'
  | 'queued'
  | { running: 'streaming' | 'waitingApproval' | 'waitingInput' }
  | 'deciding'
  | 'completed'
  | 'aborted'
  | 'error';

/** 机器 input（createActor 注入） */
export interface AgentTurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly deps: TurnDeps;
  /** 审批超时毫秒（缺省 shared APPROVAL_TIMEOUT_MS；测试注入短值） */
  readonly approvalTimeoutMs?: number;
  /** 提问超时毫秒（缺省 shared ASK_TIMEOUT_MS；测试注入短值） */
  readonly askTimeoutMs?: number;
}

/**
 * 回合状态机（XState v5 setup API）
 *
 * invoked services 是 context.deps 的薄分发（机器零效果实现）；deciding 的
 * always 有序 guard 编码历史顺序坑；终态 entry 编码清理顺序——三者共同取代
 * 原 streamToWebContents 的过程式骨架。
 */
export const agentTurnMachine = setup({
  types: {
    context: {} as AgentTurnContext,
    events: {} as TurnMachineEvent,
    input: {} as AgentTurnInput,
  },
  actors: {
    resolveModel: fromPromise(({ input }: { input: TurnDeps }) => input.resolveModel()),
    acquireGate: fromPromise(({ input }: { input: TurnDeps }) => input.acquireGate()),
    executeTurn: fromPromise(({ input }: { input: TurnDeps }) => input.executeTurn()),
  },
  delays: {
    approvalTimeout: ({ context }: { context: AgentTurnContext }) => context.approvalTimeoutMs,
    askTimeout: ({ context }: { context: AgentTurnContext }) => context.askTimeoutMs,
  },
  guards: {
    /** 超时归因（timeout reason 或 completed 形态竞态）——决策链首位（2026-09-28） */
    isTimeout: ({ context }) =>
      context.runOutput?.reason === 'timeout' || context.runOutput?.timeoutSignalAborted === true,
    /** 空回复防护（流正常结束但零 part）——决策链次位（2026-09-28） */
    isEmptyResponse: ({ context }) =>
      context.runOutput?.reason === 'completed' && context.runOutput.rawPartCount === 0,
    /** 用户中断（TurnRunner 归因；区别于 completed/timeout） */
    isAborted: ({ context }) => context.runOutput?.reason === 'aborted',
    /**
     * 本次 responded 后是否仍有待决审批（并行审批的退出判据）
     *
     * true → 仅移除刚决出的 id 并留在 waitingApproval（其余继续计时）；
     * false → 全部决出，退出到 streaming。
     */
    hasMorePendingApprovals: ({ context, event }) =>
      context.pendingApprovalIds.some(
        (id) => id !== (event as { readonly approvalId: string }).approvalId,
      ),
    /** 本次 ask.responded 后是否仍有待决提问（同 hasMorePendingApprovals 语义） */
    hasMorePendingAsks: ({ context, event }) =>
      context.pendingAskIds.some((id) => id !== (event as { readonly askId: string }).askId),
    /**
     * 中断类失败（AbortError：用户中断 / 排队让位 / 装配期信号触发）——
     * 走 aborted 终态而非 error（原 catch 的 isAbortError 分支语义：
     * 用户中断不是错误，推送 reason='aborted' 的 END）。
     * ⚠️ onError 平台事件 type 实值为 'xstate.error.actor.<id>'（探针实测），
     * 通配符 'xstate.error.actor.*' 仅在 types.events 声明中做类型匹配——
     * 运行时判定须 startsWith，全等恒 false（guard 曾因此失效走 error 出口）
     */
    isAbortFailure: ({ event }) =>
      event.type.startsWith('xstate.error.actor.') &&
      isAbortError((event as { error?: unknown }).error),
  },
  actions: {
    stashTimeoutError: assign({
      error: new AppError(ErrorCode.AI_TIMEOUT, '模型级响应总时长超时'),
    }),
    stashEmptyError: assign({
      error: new AppError(
        ErrorCode.AI_EMPTY_RESPONSE,
        '模型返回了空回复，请检查 API Key 有效性、账户余额与模型名称',
      ),
    }),
    flushForwarder: ({ context }) => {
      context.deps.flushForwarder();
    },
    releaseGate: ({ context }) => {
      context.deps.releaseGate();
    },
    clearModelTimeout: ({ context }) => {
      context.deps.clearModelTimeout();
    },
    finalizeCompleted: ({ context }) => {
      context.deps.finalizeCompleted(context.runOutput);
    },
    finalizeAborted: ({ context }) => {
      context.deps.finalizeAborted(context.runOutput);
    },
    finalizeError: ({ context }) => {
      context.deps.finalizeError(context.error);
    },
    cleanup: ({ context }) => {
      context.deps.cleanup();
    },
  },
}).createMachine({
  id: 'agentTurn',
  initial: 'resolving',
  context: ({ input }: { input: AgentTurnInput }) => ({
    sessionId: input.sessionId,
    turnId: input.turnId,
    startedAt: Date.now(),
    deps: input.deps,
    pendingApprovalIds: [],
    pendingAskIds: [],
    approvalTimeoutMs: input.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS,
    askTimeoutMs: input.askTimeoutMs ?? ASK_TIMEOUT_MS,
  }),
  states: {
    resolving: {
      invoke: {
        src: 'resolveModel',
        input: ({ context }: { context: AgentTurnContext }) => context.deps,
        onDone: {
          target: 'queued',
          actions: assign({ modelId: ({ event }) => event.output }),
        },
        onError: [
          { guard: 'isAbortFailure', target: '#agentTurn.aborted' },
          { target: 'error', actions: assign({ error: ({ event }) => event.error }) },
        ],
      },
    },
    queued: {
      invoke: {
        src: 'acquireGate',
        input: ({ context }: { context: AgentTurnContext }) => context.deps,
        onDone: { target: 'running' },
        onError: [
          { guard: 'isAbortFailure', target: '#agentTurn.aborted' },
          { target: 'error', actions: assign({ error: ({ event }) => event.error }) },
        ],
      },
    },
    running: {
      invoke: {
        src: 'executeTurn',
        input: ({ context }: { context: AgentTurnContext }) => context.deps,
        onDone: {
          target: 'deciding',
          actions: assign({ runOutput: ({ event }) => event.output }),
        },
        onError: [
          { guard: 'isAbortFailure', target: '#agentTurn.aborted' },
          { target: 'error', actions: assign({ error: ({ event }) => event.error }) },
        ],
      },
      exit: ['releaseGate', 'clearModelTimeout'],
      initial: 'streaming',
      states: {
        streaming: {
          on: {
            'approval.requested': {
              target: 'waitingApproval',
              actions: assign({ pendingApprovalIds: ({ event }) => [event.approvalId] }),
            },
            'ask.requested': {
              target: 'waitingInput',
              actions: assign({ pendingAskIds: ({ event }) => [event.askId] }),
            },
          },
        },
        waitingApproval: {
          on: {
            'approval.requested': {
              actions: assign({
                pendingApprovalIds: ({ context, event }) => [
                  ...context.pendingApprovalIds,
                  event.approvalId,
                ],
              }),
            },
            'approval.responded': [
              {
                guard: 'hasMorePendingApprovals',
                actions: assign({
                  approvalDecision: ({ event }) => event.decision,
                  pendingApprovalIds: ({ context, event }) =>
                    context.pendingApprovalIds.filter((id) => id !== event.approvalId),
                }),
              },
              {
                target: 'streaming',
                actions: [
                  assign({
                    approvalDecision: ({ event }) => event.decision,
                    pendingApprovalIds: (): readonly string[] => [],
                  }),
                ],
              },
            ],
          },
          after: {
            approvalTimeout: {
              target: 'streaming',
              actions: [
                assign({ approvalDecision: (): 'timed-out' => 'timed-out' }),
                ({ context }: { context: AgentTurnContext }) => {
                  for (const approvalId of context.pendingApprovalIds) {
                    context.deps.expireApproval(approvalId);
                  }
                },
                assign({ pendingApprovalIds: (): readonly string[] => [] }),
              ],
            },
          },
        },
        waitingInput: {
          on: {
            'ask.requested': {
              actions: assign({
                pendingAskIds: ({ context, event }) => [...context.pendingAskIds, event.askId],
              }),
            },
            'ask.responded': [
              {
                guard: 'hasMorePendingAsks',
                actions: assign({
                  askDecision: ({ event }) => event.decision,
                  pendingAskIds: ({ context, event }) =>
                    context.pendingAskIds.filter((id) => id !== event.askId),
                }),
              },
              {
                target: 'streaming',
                actions: [
                  assign({
                    askDecision: ({ event }) => event.decision,
                    pendingAskIds: (): readonly string[] => [],
                  }),
                ],
              },
            ],
          },
          after: {
            askTimeout: {
              target: 'streaming',
              actions: [
                assign({ askDecision: (): 'timed-out' => 'timed-out' }),
                ({ context }: { context: AgentTurnContext }) => {
                  for (const askId of context.pendingAskIds) {
                    context.deps.expireAsk(askId);
                  }
                },
                assign({ pendingAskIds: (): readonly string[] => [] }),
              ],
            },
          },
        },
      },
    },
    deciding: {
      always: [
        { guard: 'isTimeout', target: '#agentTurn.error', actions: 'stashTimeoutError' },
        { guard: 'isEmptyResponse', target: '#agentTurn.error', actions: 'stashEmptyError' },
        { guard: 'isAborted', target: '#agentTurn.aborted' },
        { target: '#agentTurn.completed' },
      ],
    },
    completed: {
      type: 'final',
      entry: ['flushForwarder', 'finalizeCompleted', 'cleanup'],
    },
    aborted: {
      type: 'final',
      entry: ['flushForwarder', 'finalizeAborted', 'cleanup'],
    },
    error: {
      type: 'final',
      entry: ['flushForwarder', 'finalizeError', 'cleanup'],
    },
  },
});

/** 回合状态机 Actor 类型（createActor 推导） */
export type AgentTurnActor = ReturnType<typeof createActor<typeof agentTurnMachine>>;

/**
 * 创建并启动回合状态机 Actor
 *
 * @param input 回合元数据（sessionId / turnId）+ 宿主效果依赖（deps）
 */
export function createAgentTurnActor(input: AgentTurnInput): AgentTurnActor {
  return createActor(agentTurnMachine, { input }).start();
}
