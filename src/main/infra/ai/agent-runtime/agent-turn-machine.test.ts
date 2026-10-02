// src/main/infra/ai/agent-runtime/agent-turn-machine.test.ts
// Agent 回合状态机单测：转换表全表断言（合法转换 + 决策链顺序 + 非法转换护栏）
// ──────────────────────────────────────────────────────────────
// 验证目标：
// 1. 合法路径：resolving → queued → running{streaming⇄waitingApproval} → deciding → 三终态
// 2. deciding 决策链顺序：isTimeout ▶ isEmptyResponse ▶ isAborted ▶ completed
//    （2026-09-28 顺序坑的结构性回归锚：终态吞事件类 bug 在此拦下）
// 3. 终态 entry 顺序：flushForwarder 先于 finalize 先于 cleanup（P2-31 保序）
// 4. running.exit 顺序：releaseGate 先于 clearModelTimeout
// 5. 非法转换：未声明事件被 XState 忽略；终态后事件无效
//
// 测试手法：deps 全部走 deferred（手工 resolve/reject 控制时序）+ 调用日志数组
// 断言相对顺序——不 mock 模块（机器纯层，deps 注入即全部效果面）。
// ──────────────────────────────────────────────────────────────

import { AppError, ErrorCode } from '@code-agent/shared/main';
import { describe, expect, it } from 'vitest';
import {
  type AgentTurnActor,
  type AgentTurnState,
  createAgentTurnActor,
  type TurnDeps,
} from './agent-turn-machine';

/** 手工控时的 deferred promise */
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

/** 标准 runDone 输出（按需覆盖字段） */
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

/** 测试夹具：deferred deps + 调用日志 */
function createTurn() {
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
  };
  const actor = createAgentTurnActor({ sessionId: 'session-1', turnId: 'turn-1', deps });
  const state = (): AgentTurnState => actor.getSnapshot().value;
  return { actor, state, resolveModel, acquireGate, executeTurn, log, deps };
}

/** 等待 invoked service 的 onDone/onError 处理（宏任务级：一次 setTimeout 清空全部微任务链） */
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
    // timeout reason → error(AI_TIMEOUT)，即便 rawPartCount=0 也不走空回复
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

    // completed 形态超时竞态（timeoutSignalAborted）→ error(AI_TIMEOUT)
    const t2 = createTurn();
    t2.resolveModel.resolve('m');
    await settle(t2.actor);
    t2.acquireGate.resolve();
    await settle(t2.actor);
    t2.executeTurn.resolve(runOutput({ timeoutSignalAborted: true }));
    await settle(t2.actor);
    expect(t2.state()).toBe('error');
    expect((t2.actor.getSnapshot().context.error as AppError).code).toBe(ErrorCode.AI_TIMEOUT);

    // completed + 零 part → error(AI_EMPTY_RESPONSE)，即便 timeoutSignalAborted=false
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
    t.actor.send({ type: 'approval.responded', decision: 'approved' });
    expect(t.state()).toEqual({ running: 'streaming' });
    expect(t.actor.getSnapshot().context.approvalDecision).toBe('approved');
    t.executeTurn.resolve(runOutput());
    await settle(t.actor);
    expect(t.state()).toBe('completed');
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
