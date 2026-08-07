// src/main/infra/ai/agent-runtime/agent-turn-machine.ts
// Agent 回合状态机（XState v5）· 回合执行层唯一状态权威
// ──────────────────────────────────────────────────────────────
// 背景（2026-08 决策：后端 Agent 回合层引入完整状态机）：
// - 用户确认未来必有并发子任务与暂停/恢复 → XState 引入条件满足
// - 分域采用：仅 Agent 回合执行层引入；workflow/task 保持数据快照层；
//   MCP 线性五态不引入；渲染层 AsyncView 契约不动
//
// 状态空间（对齐回合真实生命周期）：
//   pendingGate     等待并发槽位（FIFO 排队）
//   running         流执行中（流读取 / 工具调用）
//   waitingApproval 等待用户审批（工具 permission=ask）——预留状态：
//                   审批等待封装在 ToolExecutor 内部，运行时事件接入点
//                   待 ToolExecutor 审批钩子暴露后接入（诚实标注）
//   completed       正常结束（final）
//   aborted         用户中断（final）
//   error           异常结束（final）
//
// 事件：
//   gate.ready              槽位获取成功（pendingGate → running）
//   stream.finished         流正常结束（running → completed）
//   stream.aborted          用户中断（running/waitingApproval → aborted）
//   stream.error            异常（running/waitingApproval → error）
//   approval.requested      工具进入审批等待（running → waitingApproval）
//   approval.responded      审批响应（waitingApproval → running）
//
// 使用方式（护栏模式）：
//   - 现有 await 驱动执行循环保持不变（事件驱动重构 = 暂停/恢复阶段的工作）
//   - machine 作为合法转换裁决者：关键节点 send 事件，非法转换被 XState 忽略
//   - 转换合法性由 agent-turn-machine.test.ts 全表断言（测试层护栏）
// ──────────────────────────────────────────────────────────────

import { createActor, createMachine } from 'xstate';

/** 回合上下文（不可变元数据，供快照审计/落库） */
export interface AgentTurnContext {
  /** 会话 id */
  readonly sessionId: string;
  /** 回合唯一 id */
  readonly turnId: string;
  /** 模型 id（回合开始已解析） */
  readonly modelId: string;
  /** 回合开始时间戳（ms） */
  readonly startedAt: number;
}

/** 回合状态字面量联合（快照 value 推导） */
export type AgentTurnState =
  | 'pendingGate'
  | 'running'
  | 'waitingApproval'
  | 'completed'
  | 'aborted'
  | 'error';

/** 回合状态机（XState v5） */
export const agentTurnMachine = createMachine({
  id: 'agentTurn',
  initial: 'pendingGate',
  // context 由 input 初始化（回合元数据）
  context: ({ input }: { readonly input: AgentTurnContext }) => input,
  types: {} as {
    readonly context: AgentTurnContext;
    readonly events:
      | { readonly type: 'gate.ready' }
      | { readonly type: 'stream.finished' }
      | { readonly type: 'stream.aborted' }
      | { readonly type: 'stream.error'; readonly code: string; readonly message: string }
      | { readonly type: 'approval.requested'; readonly approvalId: string }
      | { readonly type: 'approval.responded' };
  },
  states: {
    // 等待并发槽位（FIFO 排队中；排队期间 abort 由 controller 处理，不进入回合状态机）
    pendingGate: {
      on: {
        'gate.ready': { target: 'running' },
      },
    },
    // 流执行中：文本/推理/工具调用均在 running 内（状态不细分，避免过度建模）
    running: {
      on: {
        // 工具审批等待（预留：接入点 = ToolExecutor 审批钩子暴露后）
        'approval.requested': { target: 'waitingApproval' },
        'stream.finished': { target: 'completed' },
        'stream.aborted': { target: 'aborted' },
        'stream.error': { target: 'error' },
      },
    },
    // 等待用户审批（审批响应恢复执行；用户中断/错误直接终态）
    waitingApproval: {
      on: {
        'approval.responded': { target: 'running' },
        'stream.aborted': { target: 'aborted' },
        'stream.error': { target: 'error' },
      },
    },
    completed: { type: 'final' },
    aborted: { type: 'final' },
    error: { type: 'final' },
  },
});

/** 回合状态机 Actor 类型（createActor 推导） */
export type AgentTurnActor = ReturnType<typeof createAgentTurnActor>;

/**
 * 创建并启动回合状态机 Actor
 *
 * @param input 回合上下文（sessionId / turnId / modelId / startedAt）
 */
export function createAgentTurnActor(
  input: AgentTurnContext,
): ReturnType<typeof createActor<typeof agentTurnMachine>> {
  return createActor(agentTurnMachine, { input }).start();
}

/**
 * 读取回合当前状态（快照 value → 字面量联合）
 */
export function getTurnState(actor: AgentTurnActor): AgentTurnState {
  return actor.getSnapshot().value as AgentTurnState;
}
