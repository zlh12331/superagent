// src/main/infra/ai/agent-runtime/agent-turn-machine.test.ts
// Agent 回合状态机单测：转换表全表断言（合法转换 + 非法转换护栏）
// ──────────────────────────────────────────────────────────────
// 验证目标：
// 1. 合法转换：pendingGate → running → 各终态；审批等待往返
// 2. 非法转换：XState 忽略未定义事件（状态不变）——测试层护栏
// 3. 上下文透传：sessionId / turnId / modelId / startedAt
// 4. 终态不可再转换（final 状态）
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { type AgentTurnActor, createAgentTurnActor, getTurnState } from './agent-turn-machine';

/** 创建回合 actor（固定上下文） */
function createTurn(): AgentTurnActor {
  return createAgentTurnActor({
    sessionId: 'session-1',
    turnId: 'turn-1',
    modelId: 'deepseek-v4-flash',
    startedAt: 1_000,
  });
}

describe('AgentTurnMachine', () => {
  it('初始状态：pendingGate（等待并发槽位）', () => {
    const actor = createTurn();
    expect(getTurnState(actor)).toBe('pendingGate');
  });

  it('合法转换：gate.ready → running', () => {
    const actor = createTurn();
    actor.send({ type: 'gate.ready' });
    expect(getTurnState(actor)).toBe('running');
  });

  it('合法转换：running → completed（stream.finished）', () => {
    const actor = createTurn();
    actor.send({ type: 'gate.ready' });
    actor.send({ type: 'stream.finished' });
    expect(getTurnState(actor)).toBe('completed');
  });

  it('合法转换：running → aborted（用户中断）', () => {
    const actor = createTurn();
    actor.send({ type: 'gate.ready' });
    actor.send({ type: 'stream.aborted' });
    expect(getTurnState(actor)).toBe('aborted');
  });

  it('合法转换：running → error（stream.error 带错误码）', () => {
    const actor = createTurn();
    actor.send({ type: 'gate.ready' });
    actor.send({ type: 'stream.error', code: 'AI_TIMEOUT', message: '超时' });
    expect(getTurnState(actor)).toBe('error');
  });

  it('合法转换：running → waitingApproval → running（审批往返）', () => {
    const actor = createTurn();
    actor.send({ type: 'gate.ready' });
    actor.send({ type: 'approval.requested', approvalId: 'ap-1' });
    expect(getTurnState(actor)).toBe('waitingApproval');
    actor.send({ type: 'approval.responded' });
    expect(getTurnState(actor)).toBe('running');
    // 审批后可正常结束
    actor.send({ type: 'stream.finished' });
    expect(getTurnState(actor)).toBe('completed');
  });

  it('合法转换：waitingApproval 时用户中断 → aborted', () => {
    const actor = createTurn();
    actor.send({ type: 'gate.ready' });
    actor.send({ type: 'approval.requested', approvalId: 'ap-1' });
    actor.send({ type: 'stream.aborted' });
    expect(getTurnState(actor)).toBe('aborted');
  });

  it('非法转换护栏：pendingGate 时 stream.finished 被忽略（状态不变）', () => {
    const actor = createTurn();
    actor.send({ type: 'stream.finished' });
    expect(getTurnState(actor)).toBe('pendingGate');
  });

  it('非法转换护栏：pendingGate 时 approval.requested 被忽略', () => {
    const actor = createTurn();
    actor.send({ type: 'approval.requested', approvalId: 'ap-1' });
    expect(getTurnState(actor)).toBe('pendingGate');
  });

  it('终态不可再转换：completed 后任意事件保持终态', () => {
    const actor = createTurn();
    actor.send({ type: 'gate.ready' });
    actor.send({ type: 'stream.finished' });
    // 终态后再发事件（非法）：被 XState 忽略，状态不变
    actor.send({ type: 'stream.aborted' });
    actor.send({ type: 'stream.error', code: 'X', message: 'y' });
    expect(getTurnState(actor)).toBe('completed');
  });

  it('上下文透传：sessionId / turnId / modelId / startedAt', () => {
    const actor = createTurn();
    const ctx = actor.getSnapshot().context;
    expect(ctx).toEqual({
      sessionId: 'session-1',
      turnId: 'turn-1',
      modelId: 'deepseek-v4-flash',
      startedAt: 1_000,
    });
  });
});
