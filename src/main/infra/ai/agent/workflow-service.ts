// src/main/infra/ai/agent/workflow-service.ts
// 工作流编排：多步骤计划执行 + 预算 + 日志（对齐 qwen workflow 域语义收敛）
// ──────────────────────────────────────────────────────────────
// 职责：
// - WorkflowRun：目标驱动的步骤序列容器（status 状态机）
// - 步骤生命周期：idle → running → completed / failed
// - 预算：步骤数软闸（isBudgetExhausted）；日志：执行轨迹（journal）
// - runWorkflow：串行编排——逐步委派子代理，前一步产出注入下一步上下文
//   （与 TeamService 的并行独立委派互补：workflow 面向依赖链任务）
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
import { logger } from '../../../utils/logger';
import { getSubagentManager, type SubagentManager } from './subagent-manager';

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

/** 上一步产出注入下一步任务的截断长度（字符；对齐 TeamService leader 序列化口径） */
const PREV_OUTPUT_INJECT_LIMIT = 1500;

/** 工作流步骤委派（串行执行的最小单元） */
export interface WorkflowStepTask {
  /** 步骤名（journal 与结果展示用） */
  readonly name: string;
  /** 委派任务描述 */
  readonly task: string;
  /** 子代理名（缺省 general） */
  readonly agent?: string;
}

/** 单步执行结果 */
export interface WorkflowStepResult {
  readonly name: string;
  readonly agent: string;
  readonly success: boolean;
  readonly output: string;
  readonly durationMs: number;
}

/** 串行编排执行结果 */
export interface WorkflowRunResult {
  readonly runId: string;
  readonly status: WorkflowStatus;
  readonly steps: readonly WorkflowStepResult[];
  readonly succeeded: number;
  readonly failed: number;
  /** 未执行的步骤数（预算软闸 / 中止 / 取消导致跳过） */
  readonly skipped: number;
}

/** 串行编排选项 */
export interface WorkflowRunOptions {
  /** 步骤预算软闸（缺省 = steps.length；超出后剩余步骤跳过） */
  readonly budgetSteps?: number;
  /** 单步失败策略：halt 中止后续（默认）/ continue 继续执行剩余步骤 */
  readonly onFailure?: 'halt' | 'continue';
  /** 父回合中断信号（每步执行前检查，触发则取消工作流） */
  readonly abortSignal?: AbortSignal;
}

/**
 * 工作流服务（可复用实例；内存编排）
 */
export class WorkflowService {
  private readonly runs = new Map<string, WorkflowRun>();

  /**
   * 构造注入（测试可控；缺省回退模块级单例，与 TeamService 同款）
   */
  constructor(private readonly manager?: SubagentManager) {}

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

  /**
   * 串行编排执行：按顺序逐步委派子代理，前一步产出注入下一步上下文
   *
   * - 状态机全程跟踪：addStep → startStep → completeStep / failStep
   * - 预算软闸：已执行步数达预算后剩余步骤跳过（journal 记录）
   * - 失败策略：halt（默认）立即 fail 终止；continue 记录失败继续后续步骤
   * - 中断：abortSignal 已中止时 cancel 工作流并跳过剩余步骤
   *
   * @param goal 工作流目标描述
   * @param steps 步骤委派列表（1-8 个）
   * @param workingDir 工作目录（子代理工具执行根目录）
   * @param options 编排选项（预算 / 失败策略 / 中断信号）
   */
  async runWorkflow(
    goal: string,
    steps: readonly WorkflowStepTask[],
    workingDir: string,
    options?: WorkflowRunOptions,
  ): Promise<WorkflowRunResult> {
    const manager = this.manager ?? getSubagentManager();
    const budget = options?.budgetSteps ?? steps.length;
    const haltOnFailure = (options?.onFailure ?? 'halt') === 'halt';
    const runId = this.create(goal, budget);
    const results: WorkflowStepResult[] = [];
    let prevOutput: string | null = null;
    let halted = false;

    for (const step of steps) {
      // 父回合中断 → 取消工作流，剩余步骤计入 skipped
      if (options?.abortSignal?.aborted === true) {
        this.addJournal(runId, `中断取消：剩余 ${steps.length - results.length} 步未执行`);
        this.cancel(runId);
        return this.buildResult(runId, results, steps.length);
      }
      // 预算软闸：剩余步骤跳过（软闸不抛错，journal 留痕）
      if (this.isBudgetExhausted(runId)) {
        this.addJournal(runId, `预算耗尽：剩余 ${steps.length - results.length} 步未执行`);
        break;
      }
      const stepId = this.addStep(runId, step.name);
      if (stepId === null) {
        break; // 工作流已终端（防御：正常路径不会到达）
      }
      // 上一步产出注入下一步任务（截断；失败信息同样传递供后续步骤感知）
      const taskText =
        prevOutput !== null
          ? `${step.task}\n\n【上一步产出】\n${prevOutput.slice(0, PREV_OUTPUT_INJECT_LIMIT)}`
          : step.task;
      const agent = step.agent ?? 'general';
      const startTime = Date.now();
      this.startStep(runId, stepId);
      try {
        const result = await manager.run(agent, taskText, workingDir);
        this.completeStep(runId, stepId, result.output.trim().slice(0, 300));
        results.push({
          name: step.name,
          agent,
          success: true,
          output: result.output,
          durationMs: result.durationMs,
        });
        prevOutput = result.output.trim();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.failStep(runId, stepId, message.slice(0, 300));
        results.push({
          name: step.name,
          agent,
          success: false,
          output: `步骤执行失败：${message}`,
          durationMs: Date.now() - startTime,
        });
        logger.warn({ workflow: runId, step: step.name, error: err }, '工作流步骤执行失败');
        if (haltOnFailure) {
          this.fail(runId, message);
          halted = true;
          break;
        }
        prevOutput = `步骤 ${step.name} 失败：${message}`;
      }
    }

    // 收尾（halt 路径已在循环内 fail；此处处理正常完成 / continue 带失败）
    // 预算软闸内全部成功视为正常完成（skipped 步骤经 journal 与结果计数体现）
    if (!halted) {
      const run = this.requireRun(runId);
      if (!TERMINAL_STATUSES.includes(run.status)) {
        if (results.some((r) => !r.success)) {
          this.fail(runId, '存在失败步骤');
        } else {
          this.complete(runId);
        }
      }
    }
    return this.buildResult(runId, results, steps.length);
  }

  /** 汇总运行结果（succeeded/failed/skipped 计数 + 终态快照） */
  private buildResult(
    runId: string,
    results: readonly WorkflowStepResult[],
    declared: number,
  ): WorkflowRunResult {
    const status = this.get(runId)?.status ?? WorkflowStatus.FAILED;
    return {
      runId,
      status,
      steps: results,
      succeeded: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      skipped: declared - results.length,
    };
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
