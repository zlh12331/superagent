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
//   deciding        runDone 决策链（guard 有序：超时 → 空回复 → 中断 → 完成）
//   completed       正常结束（final）
//   aborted         用户中断（final）
//   error           异常结束（final：模型解析失败 / 排队失败 / 超时 / 空回复 / 流异常）
//
// 事件：
//   assembly.done/.failed   模型解析完成/失败
//   gate.acquired/.failed   并发槽位获取/失败
//   turn.runDone/.runError  TurnRunner 消费完成（reason/rawPartCount/usage）/异常
//   approval.requested/.responded  审批等待/恢复（permission-service 生命周期推送）
//
// 顺序敏感语义（历史坑，已固化为 guard/entry 顺序，改动前先读测试）：
//   - deciding 决策链：isTimeout 先于 isEmptyResponse 先于 isAborted
//     （2026-09-28：终态吞事件导致快照与落库分叉）
//   - running.exit：先释放并发槽位后清模型超时定时器（让排队的下个回合尽早启动）
//   - 三终态 entry：flushForwarder 先于 finalize（合帧缓冲保序，P2-31）
//
// 宿主数据流分工：控制流相关数据（modelId/runOutput/error）进 context；
// 高频流数据（text-delta 拼接、transcript 累积）留宿主闭包——逐字符事件进
// 机器只有开销没有安全收益（rawPartCount 经 turn.runDone 输出回传供判据）。
// ──────────────────────────────────────────────────────────────

import { APPROVAL_TIMEOUT_MS, AppError, ErrorCode } from '@code-agent/shared/main';
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
  /** running 退出·模型超时定时器清理（幂等） */
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
  /** 当前等待中的审批 id（approval.requested 赋值；after 超时据此定位待决条目） */
  pendingApprovalId?: string;
  /** 审批超时毫秒（input 注入；默认 shared APPROVAL_TIMEOUT_MS，测试可缩短） */
  readonly approvalTimeoutMs: number;
}

/** 机器事件（可辨识联合；send 类型不匹配编译期报错）。
 * xstate.error.actor.* 为 v5.19+ 通配符写法：invoke onError 的平台错误事件
 * （{ type, error }）经此进入类型系统，guard/assign 可窄化读取 error 字段 */
export type TurnMachineEvent =
  | { readonly type: 'approval.requested'; readonly approvalId: string }
  | { readonly type: 'approval.responded'; readonly decision: ApprovalDecisionOutcome }
  | { readonly type: 'xstate.error.actor.*'; readonly error: unknown };

/** 回合状态字面量联合（快照 value 形态；running 为层级嵌套） */
export type AgentTurnState =
  | 'resolving'
  | 'queued'
  | { running: 'streaming' | 'waitingApproval' }
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
    approvalTimeoutMs: input.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS,
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
              actions: assign({ pendingApprovalId: ({ event }) => event.approvalId }),
            },
          },
        },
        waitingApproval: {
          on: {
            // 38 号阶段 2：responded 携带决策结果（approved/denied/timed-out/aborted），
            // context 记录供快照审计——此前出口语义黑盒（机器只知道"结束了"）
            'approval.responded': {
              target: 'streaming',
              actions: [
                assign({
                  approvalDecision: ({ event }) => event.decision,
                  // 清空等待标记（approvalId 为 string | undefined；exactOptional
                  // 语义下显式赋 undefined 需类型注解路径）
                  pendingApprovalId: (): string | undefined => undefined,
                }),
              ],
            },
          },
          // 声明式超时：进入 waitingApproval 起算，approvalTimeoutMs 后自动触发；
          // 提前 responded 退出该状态 → after 计时自动取消（无需手工 clearTimeout）。
          // 计时源单一：permission-service 不再自设超时定时器（见 TurnDeps.expireApproval）。
          after: {
            approvalTimeout: {
              target: 'streaming',
              actions: [
                // 顺序：先记决策（审计）→ 再让宿主以超时语义拒绝 pending →
                // 最后清 pendingApprovalId（内联 action 读取当时的 context）
                assign({ approvalDecision: (): 'timed-out' => 'timed-out' }),
                ({ context }: { context: AgentTurnContext }) => {
                  if (context.pendingApprovalId !== undefined) {
                    context.deps.expireApproval(context.pendingApprovalId);
                  }
                },
                assign({ pendingApprovalId: (): string | undefined => undefined }),
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
