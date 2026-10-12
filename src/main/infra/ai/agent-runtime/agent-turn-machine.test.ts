import { AppError, ErrorCode } from '@code-agent/shared/main';
import { describe, expect, it } from 'vitest';
import {
  type AgentTurnActor,
  type AgentTurnState,
  createAgentTurnActor,
  type TurnDeps,
} from './agent-turn-machine';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function runOutput(overrides?: Partial<Parameters<typeof Object.assign>[0]>): {
  reason: 'completed' | 'aborted' | 'timeout';
  durationMs: number;
  rawPartCount: number;
  usage: unknown;
  timeoutSignalAborted: boolean;
} {
  return {
    reason: 'completed',
    durationMs: 100,
    rawPartCount: 3,
    usage: { totalTokens: 42 },
    timeoutSignalAborted: false,
    ...overrides,
  };
}

function createTurn(approvalTimeoutMs?: number, askTimeoutMs?: number) {
  const resolveModel = createDeferred<string>();
  const acquireGate = createDeferred<void>();
  const executeTurn = createDeferred<{
    reason: 'completed' | 'aborted' | 'timeout';
    durationMs: number;
    rawPartCount: number;
    usage: unknown;
    timeoutSignalAborted: boolean;
  }>();
  const log: string[] = [];

  const deps: TurnDeps = {
    resolveModel: () => {
      log.push('resolveModel');
      return resolveModel.promise;
    },
    acquireGate: () => {
      log.push('acquireGate');
      return acquireGate.promise;
    },
    executeTurn: () => {
      log.push('executeTurn');
      return executeTurn.promise;
    },
    finalizeCompleted: () => {
      log.push('finalizeCompleted');
    },
    finalizeAborted: () => {
      log.push('finalizeAborted');
    },
    finalizeError: () => {
      log.push('finalizeError');
    },
    flushForwarder: () => {
      log.push('flush');
    },
    releaseGate: () => {
      log.push('releaseGate');
    },
    clearModelTimeout: () => {
      log.push('clearModelTimeout');
    },
    cleanup: () => {
      log.push('cleanup');
    },
    expireApproval: (approvalId) => {
      log.push(`expireApproval:${approvalId}`);
    },
    expireAsk: (askId) => {
      log.push(`expireAsk:${askId}`);
    },
  };
  const actor = createAgentTurnActor({
    sessionId: 'session-1',
    turnId: 'turn-1',
    deps,
    ...(approvalTimeoutMs !== undefined ? { approvalTimeoutMs } : {}),
    ...(askTimeoutMs !== undefined ? { askTimeoutMs } : {}),
  });
  const state = (): AgentTurnState => actor.getSnapshot().value as AgentTurnState;
  return { actor, state, resolveModel, acquireGate, executeTurn, log, deps };
}

async function settle(_actor: AgentTurnActor): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('AgentTurnMachine（编排者）', () => {
  it('初始状态：resolving（模型解析中）', () => {
    const { state } = createTurn();
    expect(state()).toBe('resolving');
  });

  it('assembly.done → queued（modelId 入 context）', async () => {
    const t = createTurn();
    t.resolveModel.resolve('deepseek-v4-flash');
    await settle(t.actor);
    expect(t.state()).toBe('queued');
    expect(t.actor.getSnapshot().context.modelId).toBe('deepseek-v4-flash');
  });

  it('assembly.failed → error（不进并发队列；收尾链 flush→finalizeError→cleanup）', async () => {
    const t = createTurn();
    t.resolveModel.reject(new Error('registry boom'));
    await settle(t.actor);
    expect(t.state()).toBe('error');
    expect(t.log).toEqual(['resolveModel', 'flush', 'finalizeError', 'cleanup']);
  });

  it('gate.acquired → running；gate.failed → error', async () => {
    const t = createTurn();
    t.resolveModel.resolve('m1');
    await settle(t.actor);
    t.acquireGate.resolve();
    await settle(t.actor);
    expect(t.state()).toEqual({ running: 'streaming' });

    const t2 = createTurn();
    t2.resolveModel.resolve('m1');
    await settle(t2.actor);
    t2.acquireGate.reject(new Error('gate boom'));
    await settle(t2.actor);
    expect(t2.state()).toBe('error');
    expect(t2.log).toContain('finalizeError');
  });

  it('决策链·完成：runDone(completed) → completed（finalizeCompleted 被调）', async () => {
    const t = createTurn();
    t.resolveModel.resolve('m1');
    await settle(t.actor);
    t.acquireGate.resolve();
    await settle(t.actor);
    t.executeTurn.resolve(runOutput());
    await settle(t.actor);
    expect(t.state()).toBe('completed');
    expect(t.log.slice(-3)).toEqual(['flush', 'finalizeCompleted', 'cleanup']);
  });

  it('决策链·顺序（2026-09-28 回归锚）：timeout ▶ 空回复 ▶ aborted ▶ completed', async () => {
    const t1 = createTurn();
    t1.resolveModel.resolve('m');
    await settle(t1.actor);
    t1.acquireGate.resolve();
    await settle(t1.actor);
    t1.executeTurn.resolve(runOutput({ reason: 'timeout', rawPartCount: 0 }));
    await settle(t1.actor);
    expect(t1.state()).toBe('error');
    const err1 = t1.actor.getSnapshot().context.error;
    expect(err1).toBeInstanceOf(AppError);
    expect((err1 as AppError).code).toBe(ErrorCode.AI_TIMEOUT);

    const t2 = createTurn();
    t2.resolveModel.resolve('m');
    await settle(t2.actor);
    t2.acquireGate.resolve();
    await settle(t2.actor);
    t2.executeTurn.resolve(runOutput({ timeoutSignalAborted: true }));
    await settle(t2.actor);
    expect(t2.state()).toBe('error');
    expect((t2.actor.getSnapshot().context.error as AppError).code).toBe(ErrorCode.AI_TIMEOUT);

    const t3 = createTurn();
    t3.resolveModel.resolve('m');
    await settle(t3.actor);
    t3.acquireGate.resolve();
    await settle(t3.actor);
    t3.executeTurn.resolve(runOutput({ rawPartCount: 0 }));
    await settle(t3.actor);
    expect(t3.state()).toBe('error');
    expect((t3.actor.getSnapshot().context.error as AppError).code).toBe(
      ErrorCode.AI_EMPTY_RESPONSE,
    );
  });

  it('决策链·中断：runDone(aborted) → aborted', async () => {
    const t = createTurn();
    t.resolveModel.resolve('m');
    await settle(t.actor);
    t.acquireGate.resolve();
    await settle(t.actor);
    t.executeTurn.resolve(runOutput({ reason: 'aborted' }));
    await settle(t.actor);
    expect(t.state()).toBe('aborted');
    expect(t.log.slice(-3)).toEqual(['flush', 'finalizeAborted', 'cleanup']);
  });

  it('runError → error（流异常经 onError 通道）', async () => {
    const t = createTurn();
    t.resolveModel.resolve('m');
    await settle(t.actor);
    t.acquireGate.resolve();
    await settle(t.actor);
    t.executeTurn.reject(new Error('stream boom'));
    await settle(t.actor);
    expect(t.state()).toBe('error');
    expect(t.actor.getSnapshot().context.error).toBeInstanceOf(Error);
  });

  it('审批往返：running/streaming ⇄ waitingApproval；决策结果入 context（38 号阶段 2）', async () => {
    const t = createTurn();
    t.resolveModel.resolve('m');
    await settle(t.actor);
    t.acquireGate.resolve();
    await settle(t.actor);
    t.actor.send({ type: 'approval.requested', approvalId: 'ap-1' });
    expect(t.state()).toEqual({ running: 'waitingApproval' });
    expect(t.actor.getSnapshot().context.pendingApprovalIds).toEqual(['ap-1']);
    t.actor.send({ type: 'approval.responded', approvalId: 'ap-1', decision: 'approved' });
    expect(t.state()).toEqual({ running: 'streaming' });
    expect(t.actor.getSnapshot().context.approvalDecision).toBe('approved');
    expect(t.actor.getSnapshot().context.pendingApprovalIds).toEqual([]);
    t.executeTurn.resolve(runOutput());
    await settle(t.actor);
    expect(t.state()).toBe('completed');
  });

  it('after 超时（38 号收尾）：waitingApproval 到期 → 回 streaming + expireApproval + 决策入 context', async () => {
    const t = createTurn(20);
    t.resolveModel.resolve('m');
    await settle(t.actor);
    t.acquireGate.resolve();
    await settle(t.actor);
    t.actor.send({ type: 'approval.requested', approvalId: 'ap-timeout' });
    expect(t.state()).toEqual({ running: 'waitingApproval' });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(t.state()).toEqual({ running: 'streaming' });
    expect(t.actor.getSnapshot().context.approvalDecision).toBe('timed-out');
    expect(t.log).toContain('expireApproval:ap-timeout');
    expect(t.actor.getSnapshot().context.pendingApprovalIds).toEqual([]);
  });

  it('after 超时取消语义：提前 responded → 到期不再触发 expireApproval（无需手工 clearTimeout）', async () => {
    const t = createTurn(20);
    t.resolveModel.resolve('m');
    await settle(t.actor);
    t.acquireGate.resolve();
    await settle(t.actor);
    t.actor.send({ type: 'approval.requested', approvalId: 'ap-early' });
    t.actor.send({ type: 'approval.responded', approvalId: 'ap-early', decision: 'denied' });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(t.state()).toEqual({ running: 'streaming' });
    expect(t.actor.getSnapshot().context.approvalDecision).toBe('denied');
    expect(t.log.some((x) => x.startsWith('expireApproval'))).toBe(false);
  });

  it('并行审批：两条同时待决 → 全部记账；批准一条仍留在 waitingApproval', async () => {
    const t = createTurn();
    t.resolveModel.resolve('m');
    await settle(t.actor);
    t.acquireGate.resolve();
    await settle(t.actor);

    t.actor.send({ type: 'approval.requested', approvalId: 'ap-1' });
    t.actor.send({ type: 'approval.requested', approvalId: 'ap-2' });
    await settle(t.actor);

    expect(t.state()).toEqual({ running: 'waitingApproval' });
    expect(t.actor.getSnapshot().context.pendingApprovalIds).toEqual(['ap-1', 'ap-2']);

    t.actor.send({ type: 'approval.responded', approvalId: 'ap-1', decision: 'approved' });
    await settle(t.actor);
    expect(t.state()).toEqual({ running: 'waitingApproval' });
    expect(t.actor.getSnapshot().context.pendingApprovalIds).toEqual(['ap-2']);

    t.actor.send({ type: 'approval.responded', approvalId: 'ap-2', decision: 'approved' });
    await settle(t.actor);
    expect(t.state()).toEqual({ running: 'streaming' });
    expect(t.actor.getSnapshot().context.pendingApprovalIds).toEqual([]);
  });

  it('并行审批超时：到期把**全部**待决一并过期（缺陷版只过期第一个，其余永久挂起）', async () => {
    const t = createTurn(20);
    t.resolveModel.resolve('m');
    await settle(t.actor);
    t.acquireGate.resolve();
    await settle(t.actor);
    t.actor.send({ type: 'approval.requested', approvalId: 'ap-1' });
    t.actor.send({ type: 'approval.requested', approvalId: 'ap-2' });
    await settle(t.actor);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(t.state()).toEqual({ running: 'streaming' });
    expect(t.actor.getSnapshot().context.approvalDecision).toBe('timed-out');
    expect(t.log).toContain('expireApproval:ap-1');
    expect(t.log).toContain('expireApproval:ap-2');
    expect(t.actor.getSnapshot().context.pendingApprovalIds).toEqual([]);
  });

  it('并行审批混合：先决一条、另一条超时 → 超时只过期剩余那条', async () => {
    const t = createTurn(20);
    t.resolveModel.resolve('m');
    await settle(t.actor);
    t.acquireGate.resolve();
    await settle(t.actor);
    t.actor.send({ type: 'approval.requested', approvalId: 'ap-1' });
    t.actor.send({ type: 'approval.requested', approvalId: 'ap-2' });
    await settle(t.actor);

    t.actor.send({ type: 'approval.responded', approvalId: 'ap-1', decision: 'approved' });
    await settle(t.actor);
    expect(t.state()).toEqual({ running: 'waitingApproval' });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(t.log).toContain('expireApproval:ap-2');
    expect(t.log).not.toContain('expireApproval:ap-1');
  });

  it('提问挂起：ask.requested → waitingInput → ask.responded 回 streaming（38 号收尾）', async () => {
    const t = createTurn();
    t.resolveModel.resolve('m');
    await settle(t.actor);
    t.acquireGate.resolve();
    await settle(t.actor);
    t.actor.send({ type: 'ask.requested', askId: 'ask-1' });
    expect(t.state()).toEqual({ running: 'waitingInput' });
    expect(t.actor.getSnapshot().context.pendingAskIds).toEqual(['ask-1']);
    t.actor.send({ type: 'ask.responded', askId: 'ask-1', decision: 'answered' });
    expect(t.state()).toEqual({ running: 'streaming' });
    expect(t.actor.getSnapshot().context.askDecision).toBe('answered');
    expect(t.actor.getSnapshot().context.pendingAskIds).toEqual([]);
    t.executeTurn.resolve(runOutput());
    await settle(t.actor);
    expect(t.state()).toBe('completed');
  });

  it('提问 after 超时：waitingInput 到期 → 回 streaming + expireAsk + decision=timed-out', async () => {
    const t = createTurn(undefined, 20);
    t.resolveModel.resolve('m');
    await settle(t.actor);
    t.acquireGate.resolve();
    await settle(t.actor);
    t.actor.send({ type: 'ask.requested', askId: 'ask-timeout' });
    expect(t.state()).toEqual({ running: 'waitingInput' });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(t.state()).toEqual({ running: 'streaming' });
    expect(t.actor.getSnapshot().context.askDecision).toBe('timed-out');
    expect(t.log).toContain('expireAsk:ask-timeout');
    expect(t.actor.getSnapshot().context.pendingAskIds).toEqual([]);
  });

  it('提问 after 取消语义：提前 answered → 到期不再触发 expireAsk', async () => {
    const t = createTurn(undefined, 20);
    t.resolveModel.resolve('m');
    await settle(t.actor);
    t.acquireGate.resolve();
    await settle(t.actor);
    t.actor.send({ type: 'ask.requested', askId: 'ask-early' });
    t.actor.send({ type: 'ask.responded', askId: 'ask-early', decision: 'answered' });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(t.state()).toEqual({ running: 'streaming' });
    expect(t.actor.getSnapshot().context.askDecision).toBe('answered');
    expect(t.log.some((x) => x.startsWith('expireAsk'))).toBe(false);
  });

  it('并行提问：两条同时待决 → 全部记账；答一条仍留在 waitingInput', async () => {
    const t = createTurn();
    t.resolveModel.resolve('m');
    await settle(t.actor);
    t.acquireGate.resolve();
    await settle(t.actor);

    t.actor.send({ type: 'ask.requested', askId: 'ask-1' });
    t.actor.send({ type: 'ask.requested', askId: 'ask-2' });
    await settle(t.actor);
    expect(t.actor.getSnapshot().context.pendingAskIds).toEqual(['ask-1', 'ask-2']);

    t.actor.send({ type: 'ask.responded', askId: 'ask-1', decision: 'answered' });
    await settle(t.actor);
    expect(t.state()).toEqual({ running: 'waitingInput' });
    expect(t.actor.getSnapshot().context.pendingAskIds).toEqual(['ask-2']);

    t.actor.send({ type: 'ask.responded', askId: 'ask-2', decision: 'answered' });
    await settle(t.actor);
    expect(t.state()).toEqual({ running: 'streaming' });
  });

  it('并行提问超时：到期把全部待决一并过期（对称修复）', async () => {
    const t = createTurn(undefined, 20);
    t.resolveModel.resolve('m');
    await settle(t.actor);
    t.acquireGate.resolve();
    await settle(t.actor);
    t.actor.send({ type: 'ask.requested', askId: 'ask-1' });
    t.actor.send({ type: 'ask.requested', askId: 'ask-2' });
    await settle(t.actor);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(t.log).toContain('expireAsk:ask-1');
    expect(t.log).toContain('expireAsk:ask-2');
    expect(t.actor.getSnapshot().context.pendingAskIds).toEqual([]);
  });

  it('exit 顺序：releaseGate 先于 clearModelTimeout（排队下回合尽早启动）', async () => {
    const t = createTurn();
    t.resolveModel.resolve('m');
    await settle(t.actor);
    t.acquireGate.resolve();
    await settle(t.actor);
    t.executeTurn.resolve(runOutput());
    await settle(t.actor);
    const gateIdx = t.log.indexOf('releaseGate');
    const clearIdx = t.log.indexOf('clearModelTimeout');
    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(clearIdx).toBeGreaterThan(gateIdx);
  });

  it('非法转换护栏：queued 时 approval.requested 被忽略（状态不变）', async () => {
    const t = createTurn();
    t.resolveModel.resolve('m');
    await settle(t.actor);
    t.actor.send({ type: 'approval.requested', approvalId: 'ap-early' });
    expect(t.state()).toBe('queued');
  });

  it('终态不可再转换：completed 后任意事件保持终态（finalize/cleanup 各仅一次）', async () => {
    const t = createTurn();
    t.resolveModel.resolve('m');
    await settle(t.actor);
    t.acquireGate.resolve();
    await settle(t.actor);
    t.executeTurn.resolve(runOutput());
    await settle(t.actor);
    const logLength = t.log.length;
    t.actor.send({ type: 'approval.requested', approvalId: 'ap-x' });
    await settle(t.actor);
    expect(t.state()).toBe('completed');
    expect(t.log.length).toBe(logLength);
    expect(t.log.filter((x) => x === 'cleanup')).toHaveLength(1);
  });

  it('上下文透传：sessionId / turnId / deps', () => {
    const t = createTurn();
    const ctx = t.actor.getSnapshot().context;
    expect(ctx.sessionId).toBe('session-1');
    expect(ctx.turnId).toBe('turn-1');
    expect(ctx.deps).toBe(t.deps);
  });
});
