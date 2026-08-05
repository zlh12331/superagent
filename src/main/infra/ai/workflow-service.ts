// src/main/infra/ai/workflow-service.ts
// 工作流编排：多步骤计划执行 + 预算 + 日志（对齐 qwen workflow 域语义收敛）
// ──────────────────────────────────────────────────────────────
// 职责：
// - WorkflowRun：目标驱动的步骤序列容器（status 状态机）
// - 步骤生命周期：idle → running → completed / failed
// - 预算：步骤数软闸（isBudgetExhausted）；日志：执行轨迹（journal）
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/core/src/agents/runtime/
// workflow-orchestrator.ts + workflow-budget.ts + workflow-journal.ts
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// 编排语义，按我们的技术栈收敛重写：
// - 移除沙箱/脚本执行/快照/存续恢复（强耦合 qwen 沙箱体系，桌面端由会话持久化覆盖）
// - 保留核心语义：步骤状态机 + 预算软闸 + 执行日志
// - 收敛为内存编排（持久化标注后置：与任务/记忆先例一致，先功能后存储）
// ──────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';

/** 工作流状态 */
export const WorkflowStatus = {
  IDLE: 'idle',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export type WorkflowStatus = (typeof WorkflowStatus)[keyof typeof WorkflowStatus];

/** 步骤状态 */
export const WorkflowStepStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type WorkflowStepStatus = (typeof WorkflowStepStatus)[keyof typeof WorkflowStepStatus];

/** 工作流步骤 */
export interface WorkflowStep {
  readonly id: string;
  /** 步骤名（人类可读） */
  readonly name: string;
  readonly status: WorkflowStepStatus;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** 步骤输出/错误说明 */
  readonly output: string | null;
}

/** 工作流运行 */
export interface WorkflowRun {
  readonly id: string;
  /** 目标描述 */
  readonly goal: string;
  /** 步骤序列（按添加顺序） */
  readonly steps: readonly WorkflowStep[];
  readonly status: WorkflowStatus;
  /** 预算（最大步骤数；软闸） */
  readonly budgetSteps: number;
  /** 执行日志（轨迹） */
  readonly journal: readonly string[];
  readonly createdAt: number;
}

/** 终端状态（运行不可再变） */
const TERMINAL_STATUSES: readonly WorkflowStatus[] = [
  WorkflowStatus.COMPLETED,
  WorkflowStatus.FAILED,
  WorkflowStatus.CANCELLED,
];

/**
 * 工作流服务（可复用实例；内存编排）
 */
export class WorkflowService {
  private readonly runs = new Map<string, WorkflowRun>();

  /**
   * 创建工作流（idle，步骤预算由 goal 阶段确定）
   */
  create(goal: string, budgetSteps: number): string {
    const run: WorkflowRun = {
      id: randomUUID(),
      goal,
      steps: [],
      status: WorkflowStatus.IDLE,
      budgetSteps: Math.max(1, budgetSteps),
      journal: [`工作流创建：${goal}`],
      createdAt: Date.now(),
    };
    this.runs.set(run.id, run);
    return run.id;
  }

  /**
   * 追加步骤（pending；工作流须未结束）
   *
   * @returns 步骤 id；工作流已结束返回 null
   */
  addStep(runId: string, name: string): string | null {
    const run = this.requireRun(runId);
    if (TERMINAL_STATUSES.includes(run.status)) {
      return null;
    }
    const step: WorkflowStep = {
      id: randomUUID(),
      name,
      status: WorkflowStepStatus.PENDING,
      startedAt: null,
      endedAt: null,
      output: null,
    };
    this.mutate(runId, (current) => ({
      ...current,
      steps: [...current.steps, step],
      journal: [...current.journal, `步骤添加：${name}`],
    }));
    return step.id;
  }

  /** 开始步骤（pending → running） */
  startStep(runId: string, stepId: string): void {
    this.transitionStep(runId, stepId, WorkflowStepStatus.RUNNING);
  }

  /** 完成步骤（running → completed；记录输出） */
  completeStep(runId: string, stepId: string, output?: string): void {
    this.transitionStep(runId, stepId, WorkflowStepStatus.COMPLETED, output ?? null);
  }

  /** 失败步骤（running/pending → failed；记录错误） */
  failStep(runId: string, stepId: string, error?: string): void {
    this.transitionStep(runId, stepId, WorkflowStepStatus.FAILED, error ?? null);
  }

  /** 追加执行日志 */
  addJournal(runId: string, entry: string): void {
    this.mutate(runId, (current) => ({
      ...current,
      journal: [...current.journal, entry],
    }));
  }

  /** 预算软闸：已用步骤（含运行中）≥ 预算 */
  isBudgetExhausted(runId: string): boolean {
    const run = this.requireRun(runId);
    return run.steps.length >= run.budgetSteps;
  }

  /** 完成工作流（全部步骤 completed 才允许；否则抛错） */
  complete(runId: string): void {
    const run = this.requireRun(runId);
    if (TERMINAL_STATUSES.includes(run.status)) {
      return;
    }
    const unfinished = run.steps.filter(
      (step) =>
        step.status === WorkflowStepStatus.PENDING || step.status === WorkflowStepStatus.RUNNING,
    );
    if (unfinished.length > 0) {
      throw new Error(`工作流存在未完成步骤（${unfinished.map((s) => s.name).join(', ')}）`);
    }
    this.mutate(runId, (current) => ({
      ...current,
      status: WorkflowStatus.COMPLETED,
      journal: [...current.journal, '工作流完成'],
    }));
  }

  /** 失败工作流（记录错误；状态机终端） */
  fail(runId: string, error?: string): void {
    const run = this.requireRun(runId);
    if (TERMINAL_STATUSES.includes(run.status)) {
      return;
    }
    this.mutate(runId, (current) => ({
      ...current,
      status: WorkflowStatus.FAILED,
      journal: [...current.journal, `工作流失败：${error ?? '未知原因'}`],
    }));
  }

  /** 取消工作流 */
  cancel(runId: string): void {
    const run = this.requireRun(runId);
    if (TERMINAL_STATUSES.includes(run.status)) {
      return;
    }
    this.mutate(runId, (current) => ({
      ...current,
      status: WorkflowStatus.CANCELLED,
      journal: [...current.journal, '工作流取消'],
    }));
  }

  /** 列出全部工作流（创建时间倒序 + id 兜底确定性） */
  list(): WorkflowRun[] {
    return [...this.runs.values()].sort(
      (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
    );
  }

  /** 获取单个工作流 */
  get(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId);
  }

  /** 步骤状态转换（终端步骤锁定） */
  private transitionStep(
    runId: string,
    stepId: string,
    status: WorkflowStepStatus,
    output?: string | null,
  ): void {
    const run = this.requireRun(runId);
    if (TERMINAL_STATUSES.includes(run.status)) {
      return;
    }
    const step = run.steps.find((s) => s.id === stepId);
    if (step === undefined) {
      throw new Error(`步骤不存在：${stepId}`);
    }
    // 终端步骤锁定（completed/failed 不可再变）
    if (step.status === WorkflowStepStatus.COMPLETED || step.status === WorkflowStepStatus.FAILED) {
      return;
    }
    this.mutate(runId, (current) => ({
      ...current,
      steps: current.steps.map((s) =>
        s.id === stepId
          ? {
              ...s,
              status,
              startedAt: status === WorkflowStepStatus.RUNNING ? Date.now() : s.startedAt,
              endedAt:
                status === WorkflowStepStatus.COMPLETED || status === WorkflowStepStatus.FAILED
                  ? Date.now()
                  : s.endedAt,
              output: output !== undefined ? output : s.output,
            }
          : s,
      ),
      status: current.status === WorkflowStatus.IDLE ? WorkflowStatus.RUNNING : current.status,
      journal: [...current.journal, `步骤 ${status}：${step.name}`],
    }));
  }

  /** 不可变更新（保持领域类型只读） */
  private mutate(runId: string, updater: (current: WorkflowRun) => WorkflowRun): void {
    const run = this.requireRun(runId);
    this.runs.set(runId, updater(run));
  }

  private requireRun(runId: string): WorkflowRun {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new Error(`工作流不存在：${runId}`);
    }
    return run;
  }
}

/** 模块级单例（ServiceContainer 与工具共用） */
export const workflowService = new WorkflowService();
