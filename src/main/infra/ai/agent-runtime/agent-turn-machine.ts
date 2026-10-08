// src/main/infra/ai/agent-runtime/agent-turn-machine.ts
// Agent 回合状态机（XState v5 setup API）· 回合执行层唯一状态权威 + 编排者
// ──────────────────────────────────────────────────────────────
// 演进（38 号 spec）：2026-08 引入时为护栏模式（机器旁观记账、执行流仍是
// streamToWebContents 过程式代码）；本版升级为编排者——模型解析/排队/回合
// 执行的控制流全部由机器驱动，宿主效果经 TurnDeps 注入（AutostartDeps 同款
// 依赖注入模式），机器保持纯层（不 import electron/db/infra；shared 仅
// AppError/ErrorCode，供错误终态构造）。
//
// 状态空间：
//   resolving       解析当前模型（轻量；失败 → error，不进并发队列）
//   queued          等待并发槽位（FIFO 排队；排队期 abort 由 acquireGate 拒绝承载）
//   running         回合执行（重装配 + streamText + TurnRunner 消费 + usage 等待）
//     streaming             流执行中（文本/推理/工具调用不细分，避免过度建模）
//     waitingApproval       等待用户审批（permission=ask；approval.responded 恢复）
//     waitingInput          等待用户回答提问（ask_user_question 挂起；ask.responded 恢复）
//   deciding        runDone 决策链（guard 有序：超时 → 空回复 → 中断 → 完成）
//   completed       正常结束（final）
//   aborted         用户中断（final）
//   error           异常结束（final：模型解析失败 / 排队失败 / 超时 / 空回复 / 流异常）
//
// 事件与转换：
// - 显式事件（send）：approval.requested/.responded、ask.requested/.responded
//   （审批/提问生命周期推送，turn-subscriptions 按 sessionId 过滤后转发）、
//   xstate.error.actor.*（invoke 平台错误事件，types 声明通配符做类型匹配）
// - invoked services 的完成/失败走 onDone/onError 内联转换（非显式事件）：
//   resolving 的 done/.failed、queued 的 acquired/.failed、running 的
//   runDone/.runError——模型解析/槽位获取/回合执行的三个阶段
//
// 顺序敏感语义（历史坑，已固化为 guard/entry 顺序，改动前先读测试）：
//   - deciding 决策链：isTimeout 先于 isEmptyResponse 先于 isAborted
//     （2026-09-28：终态吞事件导致快照与落库分叉）
//   - running.exit：先释放并发槽位后清模型超时定时器（让排队的下个回合尽早启动；
//     clearModelTimeout 宿主当前为显式 no-op——定时器由 turn-assembly try/finally 自管）
//   - 三终态 entry：flushForwarder 先于 finalize（合帧缓冲保序，P2-31）
//
// 宿主数据流分工：控制流相关数据（modelId/runOutput/error）进 context；
// 高频流数据（text-delta 拼接、transcript 累积）留宿主闭包——逐字符事件进
// 机器只有开销没有安全收益（rawPartCount 经 turn.runDone 输出回传供判据）。
// ──────────────────────────────────────────────────────────────

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
    // ⚠️ v5 invoked actor 回调实参为 { input, system, self, signal, emit }——没有
    // context；父机器数据必须经 invoke.input 显式传入（见各状态的 invoke.input）
    resolveModel: fromPromise(({ input }: { input: TurnDeps }) => input.resolveModel()),
    acquireGate: fromPromise(({ input }: { input: TurnDeps }) => input.acquireGate()),
    executeTurn: fromPromise(({ input }: { input: TurnDeps }) => input.executeTurn()),
  },
  // 命名延迟（after 转换引用；动态值从 context 取——审批超时可注入短值供测试）
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
    // 超时/空回复的错误构造（错误码真源在 shared；宿主 finalizeError 消费）。
    // 决策链 guard 命中后进入 error 终态前赋值。
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
    // 模型解析（轻量）：失败直接 error（不进并发队列——排队前失败不占槽位）。
    // onDone/onError 的内联 action 读取平台事件（DoneActorEvent.output / ErrorActorEvent.error）
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
    // 等待并发槽位（FIFO；排队期 abort 由 acquireGate 以 AbortError 拒绝承载）
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
    // 回合执行：重装配 + 流消费在 executeTurn service 内（控制流在此，效果在宿主）
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
      // exit 顺序敏感：先释放槽位（排队的下个回合尽早启动）后清定时器
      exit: ['releaseGate', 'clearModelTimeout'],
      initial: 'streaming',
      states: {
        streaming: {
          on: {
            'approval.requested': {
              target: 'waitingApproval',
              // 进入等待：首条审批入列（后续同轮请求由 waitingApproval 状态内
              // 的 'approval.requested' 自转换累加）
              actions: assign({ pendingApprovalIds: ({ event }) => [event.approvalId] }),
            },
            // 提问挂起（ask_user_question）：此前机器完全不感知，挂起期间显示
            // streaming（状态失真）；38 号阶段 2 收尾补齐为 waitingInput 状态
            'ask.requested': {
              target: 'waitingInput',
              // 进入等待：首条提问入列（后续同轮提问由 waitingInput 内自转换累加）
              actions: assign({ pendingAskIds: ({ event }) => [event.askId] }),
            },
          },
        },
        waitingApproval: {
          on: {
            // 并行审批（2026-10-08 修复）：一轮模型回复可含多个 ask 工具调用，
            // AI SDK 以 Promise.all 并行执行 → 多个 requestApproval 并发到达。
            // 此前本状态只处理 responded，第 2 个 requested 被静默忽略：它既无
            // 机器记账、也无 after 计时，其工具 Promise 永不 settle，回合永久挂起。
            // 语义对齐 waitingApproval 的「等待全部待决审批」：
            // - requested：累加 id（保持停留本状态；after 计时随状态重入而重置）
            // - responded：移除该 id；**仍有待决则留在本状态**（继续计时），
            //   全部决出才回 streaming
            'approval.requested': {
              actions: assign({
                pendingApprovalIds: ({ context, event }) => [
                  ...context.pendingApprovalIds,
                  event.approvalId,
                ],
              }),
            },
            // 38 号阶段 2：responded 携带决策结果（approved/denied/timed-out/aborted），
            // context 记录供快照审计——此前出口语义黑盒（机器只知道"结束了"）
            'approval.responded': [
              {
                // 还有其它待决审批：仅移除本 id，留在 waitingApproval 继续计时
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
                    // 清空等待标记（exactOptional 语义下显式赋空数组）
                    pendingApprovalIds: (): readonly string[] => [],
                  }),
                ],
              },
            ],
          },
          // 声明式超时：进入/重入 waitingApproval 起算，approvalTimeoutMs 后自动触发；
          // 提前全决退出该状态 → after 计时自动取消（无需手工 clearTimeout）。
          // 计时源单一：permission-service 不再自设超时定时器（见 TurnDeps.expireApproval）。
          // 并行语义：超时到点时**全部**待决审批一并过期（它们同时进入等待）。
          after: {
            approvalTimeout: {
              target: 'streaming',
              actions: [
                // 顺序：先记决策（审计）→ 再让宿主以超时语义拒绝全部 pending →
                // 最后清空 id 列表（内联 action 读取当时的 context）
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
        // 等待用户回答提问（ask_user_question 挂起；与 waitingApproval 同构）
        //
        // 并行提问（2026-10-08 对称修复）：与审批同理，一轮可含多个 ask 工具调用
        // （AI SDK 并行执行），此前第 2 个 ask.requested 被忽略 → 其工具 Promise
        // 永久挂起。此处采用与 waitingApproval 相同的「列表 + 全部决出才退出」语义。
        // 前端 AskDialog 同步队列化（FIFO 逐条呈现队头，超时由决议事件放行），
        // 两端对称：后端不再永久挂起，前端不再覆盖丢失。
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
          // 声明式超时（同 waitingApproval）：提前全答退出 → after 自动取消。
          // 计时源单一：agent-ask-service 不再自设 setTimeout（见 TurnDeps.expireAsk）。
          // 超时到点把**全部**待决提问一并过期（它们同时进入等待）。
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
    // runDone 决策链：guard 有序（超时 → 空回复 → 中断 → 完成），首个匹配生效
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
      // entry 顺序敏感：flush 先于 finalize（合帧缓冲保序，P2-31）
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
