// workflow-service.ts：多步工作流——按计划驱动子代理逐步执行（journal 记录、步数预算、可取消）
import { randomUUID } from 'node:crypto';
import { logger } from '../../../utils/logger';
import { getSubagentManager, type SubagentManager } from './subagent-manager';

// 状态常量对象（值即类型——shared 里同形约定的本地版；workflow 未入 IPC schema，仅 UI 展示态）
export const WorkflowStatus = {
  IDLE: 'idle',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export type WorkflowStatus = (typeof WorkflowStatus)[keyof typeof WorkflowStatus];

export const WorkflowStepStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type WorkflowStepStatus = (typeof WorkflowStepStatus)[keyof typeof WorkflowStepStatus];

/** 工作流单步（状态机四态；output 为子代理产出文本） */
export interface WorkflowStep {
  readonly id: string;
  readonly name: string;
  readonly status: WorkflowStepStatus;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly output: string | null;
}

/** 一次工作流运行（goal + 步骤序列 + 步数预算 + journal 日志） */
export interface WorkflowRun {
  readonly id: string;
  readonly goal: string;
  readonly steps: readonly WorkflowStep[];
  readonly status: WorkflowStatus;
  readonly budgetSteps: number;
  readonly journal: readonly string[];
  readonly createdAt: number;
}

const TERMINAL_STATUSES: readonly WorkflowStatus[] = [
  WorkflowStatus.COMPLETED,
  WorkflowStatus.FAILED,
  WorkflowStatus.CANCELLED,
];

const PREV_OUTPUT_INJECT_LIMIT = 1500;

export interface WorkflowStepTask {
  readonly name: string;
  readonly task: string;
  readonly agent?: string;
}

export interface WorkflowStepResult {
  readonly name: string;
  readonly agent: string;
  readonly success: boolean;
  readonly output: string;
  readonly durationMs: number;
}

export interface WorkflowRunResult {
  readonly runId: string;
  readonly status: WorkflowStatus;
  readonly steps: readonly WorkflowStepResult[];
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface WorkflowRunOptions {
  readonly budgetSteps?: number;
  readonly onFailure?: 'halt' | 'continue';
  readonly abortSignal?: AbortSignal;
}

export class WorkflowService {
  private readonly runs = new Map<string, WorkflowRun>();

  constructor(private readonly manager?: SubagentManager) {}

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

  startStep(runId: string, stepId: string): void {
    this.transitionStep(runId, stepId, WorkflowStepStatus.RUNNING);
  }

  completeStep(runId: string, stepId: string, output?: string): void {
    this.transitionStep(runId, stepId, WorkflowStepStatus.COMPLETED, output ?? null);
  }

  failStep(runId: string, stepId: string, error?: string): void {
    this.transitionStep(runId, stepId, WorkflowStepStatus.FAILED, error ?? null);
  }

  addJournal(runId: string, entry: string): void {
    this.mutate(runId, (current) => ({
      ...current,
      journal: [...current.journal, entry],
    }));
  }

  isBudgetExhausted(runId: string): boolean {
    const run = this.requireRun(runId);
    return run.steps.length >= run.budgetSteps;
  }

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

  list(): WorkflowRun[] {
    return [...this.runs.values()].sort(
      (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
    );
  }

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
      if (options?.abortSignal?.aborted === true) {
        this.addJournal(runId, `中断取消：剩余 ${steps.length - results.length} 步未执行`);
        this.cancel(runId);
        return this.buildResult(runId, results, steps.length);
      }
      if (this.isBudgetExhausted(runId)) {
        this.addJournal(runId, `预算耗尽：剩余 ${steps.length - results.length} 步未执行`);
        break;
      }
      const stepId = this.addStep(runId, step.name);
      if (stepId === null) {
        break;
      }
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

  get(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId);
  }

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

export const workflowService = new WorkflowService();
