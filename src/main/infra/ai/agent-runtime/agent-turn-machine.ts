import { APPROVAL_TIMEOUT_MS, AppError, ASK_TIMEOUT_MS, ErrorCode } from '@code-agent/shared/main';
import { assign, createActor, fromPromise, setup } from 'xstate';
import { isAbortError } from '../tools/error-classifier';
import type { ApprovalDecisionOutcome } from '../tools/permission-types';
export interface TurnRunOutput {
  readonly reason: 'completed' | 'aborted' | 'timeout';
  readonly durationMs: number;
  readonly rawPartCount: number;
  readonly usage: unknown;
  readonly timeoutSignalAborted: boolean;
}

export interface TurnDeps {
  resolveModel(): Promise<string>;
  acquireGate(): Promise<void>;
  executeTurn(): Promise<TurnRunOutput>;
  finalizeCompleted(output: TurnRunOutput | undefined): void;
  finalizeAborted(output: TurnRunOutput | undefined): void;
  finalizeError(error: unknown): void;
  flushForwarder(): void;
  releaseGate(): void;
  clearModelTimeout(): void;
  cleanup(): void;
  expireApproval(approvalId: string): void;
  expireAsk(askId: string): void;
}

export interface AgentTurnContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly startedAt: number;
  readonly deps: TurnDeps;
  modelId?: string;
  runOutput?: TurnRunOutput;
  error?: unknown;
  approvalDecision?: ApprovalDecisionOutcome;
  pendingApprovalIds: readonly string[];
  readonly approvalTimeoutMs: number;
  pendingAskIds: readonly string[];
  readonly askTimeoutMs: number;
  askDecision?: 'answered' | 'timed-out';
}

export type TurnMachineEvent =
  | { readonly type: 'approval.requested'; readonly approvalId: string }
  | {
      readonly type: 'approval.responded';
      readonly approvalId: string;
      readonly decision: ApprovalDecisionOutcome;
    }
  | { readonly type: 'ask.requested'; readonly askId: string }
  | {
      readonly type: 'ask.responded';
      readonly askId: string;
      readonly decision: 'answered' | 'timed-out';
    }
  | { readonly type: 'xstate.error.actor.*'; readonly error: unknown };

export type AgentTurnState =
  | 'resolving'
  | 'queued'
  | { running: 'streaming' | 'waitingApproval' | 'waitingInput' }
  | 'deciding'
  | 'completed'
  | 'aborted'
  | 'error';

export interface AgentTurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly deps: TurnDeps;
  readonly approvalTimeoutMs?: number;
  readonly askTimeoutMs?: number;
}

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
    isTimeout: ({ context }) =>
      context.runOutput?.reason === 'timeout' || context.runOutput?.timeoutSignalAborted === true,
    isEmptyResponse: ({ context }) =>
      context.runOutput?.reason === 'completed' && context.runOutput.rawPartCount === 0,
    isAborted: ({ context }) => context.runOutput?.reason === 'aborted',
    hasMorePendingApprovals: ({ context, event }) =>
      context.pendingApprovalIds.some(
        (id) => id !== (event as { readonly approvalId: string }).approvalId,
      ),
    hasMorePendingAsks: ({ context, event }) =>
      context.pendingAskIds.some((id) => id !== (event as { readonly askId: string }).askId),
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

export type AgentTurnActor = ReturnType<typeof createActor<typeof agentTurnMachine>>;

export function createAgentTurnActor(input: AgentTurnInput): AgentTurnActor {
  return createActor(agentTurnMachine, { input }).start();
}
