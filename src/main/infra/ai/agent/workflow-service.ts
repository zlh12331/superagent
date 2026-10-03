// src/main/infra/ai/agent/workflow-service.ts
// 工作流编排：多步骤计划执行 + 预算软闸 + 执行日志（对齐 qwen workflow 域语义收敛）
// ──────────────────────────────────────────────────────────────
// 职责：
// - WorkflowRun：目标驱动的步骤序列容器（status 状态机）
// - 步骤生命周期：pending → running → completed / failed（见 WorkflowStepStatus）
// - 预算：步骤数软闸（isBudgetExhausted）；日志：执行轨迹（journal）
// - runWorkflow：串行编排——逐步委派子代理，前一步产出注入下一步上下文
//   （与 TeamService 的并行独立委派互补：workflow 面向依赖链任务）
//
// 现状（勿套用其他服务先例）：
// - 纯内存编排：runs 存实例 Map，跨重启丢失；持久化是独立后置项，尚未实施
//   （对比 task-service 已落 tasks 表、记忆引擎已落 userData/memory-hub）
// - 非 ServiceContainer accessor：仅 run_workflow 工具经模块级单例调用
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/core/src/agents/runtime/
// workflow-orchestrator.ts + workflow-budget.ts + workflow-journal.ts
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// 编排语义，按我们的技术栈收敛重写：
// - 移除沙箱/脚本执行/快照/存续恢复（强耦合 qwen 沙箱体系，桌面端由会话持久化覆盖）
// - 保留核心语义：步骤状态机 + 预算软闸 + 执行日志
// - 收敛为内存编排（持久化后置，见上「现状」）
// ──────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { logger } from '../../../utils/logger';
import { getSubagentManager, type SubagentManager } from './subagent-manager';

/** 工作流状态常量表（取值即下方联合类型的唯一来源，勿手写字面量重复） */
export const WorkflowStatus = {
  IDLE: 'idle',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

/**
 * 工作流状态机取值：idle → running → completed / failed / cancelled
 *
 * IDLE 由 create 置位；首次步骤转换（transitionStep）自动把 IDLE 提升为 RUNNING；
 * completed / failed / cancelled 为终端态（见 TERMINAL_STATUSES），此后追加步骤与状态转换均被忽略。
 */
export type WorkflowStatus = (typeof WorkflowStatus)[keyof typeof WorkflowStatus];

/** 步骤状态常量表（取值即下方联合类型的唯一来源） */
export const WorkflowStepStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

/**
 * 步骤状态机取值：pending → running → completed / failed
 *
 * addStep 落 PENDING；completed / failed 为终端步骤态，transitionStep 对其实施锁定（不可再变）。
 */
export type WorkflowStepStatus = (typeof WorkflowStepStatus)[keyof typeof WorkflowStepStatus];

/** 工作流步骤（只读快照；变更经 WorkflowService.mutate 整体替换） */
export interface WorkflowStep {
  /** 步骤唯一 id（randomUUID，addStep 生成） */
  readonly id: string;
  /** 步骤名（人类可读；journal 与失败信息回显用） */
  readonly name: string;
  readonly status: WorkflowStepStatus;
  /** 开始时间（Unix ms；仅 RUNNING 转换时写入，此前为 null） */
  readonly startedAt: number | null;
  /** 结束时间（Unix ms；仅 completed/failed 转换时写入，此前为 null） */
  readonly endedAt: number | null;
  /** 步骤输出/错误说明（transitionStep 传入值；runWorkflow 侧截断 300 字符） */
  readonly output: string | null;
}

/** 工作流运行（目标 + 步骤序列 + 状态 + 轨迹的只读快照） */
export interface WorkflowRun {
  /** 运行唯一 id（randomUUID） */
  readonly id: string;
  /** 目标描述（创建时传入） */
  readonly goal: string;
  /** 步骤序列（按 addStep 添加顺序；不可变数组，更新即整体替换） */
  readonly steps: readonly WorkflowStep[];
  readonly status: WorkflowStatus;
  /** 步骤预算（最大步骤数；软闸——超出即跳过剩余步骤而非抛错；create 时下限 1） */
  readonly budgetSteps: number;
  /** 执行日志（轨迹；创建/加步/状态转换/预算耗尽/中断各留一行） */
  readonly journal: readonly string[];
  /** 创建时间（Unix ms） */
  readonly createdAt: number;
}

/** 工作流终端状态集：命中后所有写操作（加步/状态转换/complete/fail/cancel）均提前返回，运行不可再变 */
const TERMINAL_STATUSES: readonly WorkflowStatus[] = [
  WorkflowStatus.COMPLETED,
  WorkflowStatus.FAILED,
  WorkflowStatus.CANCELLED,
];

/**
 * 上一步产出注入下一步任务的截断长度（字符）
 *
 * 对齐 TeamService leader 序列化口径（team-service.ts 成员结果序列化同样 slice(0, 1500)），
 * 防止长产出把下一步任务文本撑爆。
 */
const PREV_OUTPUT_INJECT_LIMIT = 1500;

/** 工作流步骤委派（串行执行的最小单元；由调用方一次性给出，非运行期追加） */
export interface WorkflowStepTask {
  /** 步骤名（journal 与结果展示用） */
  readonly name: string;
  /** 委派任务描述（执行时会追加「【上一步产出】」段，首步不追加） */
  readonly task: string;
  /** 子代理名（缺省 general；须为 SubagentManager 已注册的代理，否则该步抛错） */
  readonly agent?: string;
}

/** 单步执行结果（成功为子代理完整产出；失败为「步骤执行失败：<原因>」说明文本） */
export interface WorkflowStepResult {
  readonly name: string;
  readonly agent: string;
  readonly success: boolean;
  /** 子代理完整产出（未截断；注入下一步与结果展示才做截断） */
  readonly output: string;
  /** 耗时（成功取子代理自报 durationMs，失败取本地 Date.now() 差值） */
  readonly durationMs: number;
}

/** 串行编排执行结果（runId 可用于回查 WorkflowRun 终态快照） */
export interface WorkflowRunResult {
  readonly runId: string;
  readonly status: WorkflowStatus;
  /** 已实际执行的步骤结果（跳过的步骤不进入本列表） */
  readonly steps: readonly WorkflowStepResult[];
  readonly succeeded: number;
  readonly failed: number;
  /** 未执行的步骤数 = 声明步骤总数 − 已执行数（预算软闸 / 中止 / 取消导致跳过） */
  readonly skipped: number;
}

/** 串行编排选项 */
export interface WorkflowRunOptions {
  /** 步骤预算软闸（缺省 = steps.length；已添加步骤数达此值后剩余步骤跳过并记 journal） */
  readonly budgetSteps?: number;
  /** 单步失败策略：halt 中止后续（默认）/ continue 继续执行剩余步骤（整体仍判 FAILED） */
  readonly onFailure?: 'halt' | 'continue';
  /** 父回合中断信号（每步执行前检查；已中止则取消工作流，剩余步骤计入 skipped） */
  readonly abortSignal?: AbortSignal;
}

/**
 * 工作流服务（可复用实例；纯内存编排，runs 生命周期 = 实例生命周期）
 *
 * runWorkflow 是完整编排入口；本类同时暴露细粒度状态转换 API
 * （addStep/startStep/completeStep/failStep/...），供需要手动驱动的调用方使用。
 */
export class WorkflowService {
  /** 运行注册表：runId → 运行快照（全量内存，不落库） */
  private readonly runs = new Map<string, WorkflowRun>();

  /**
   * 构造注入子代理管理器（测试可控；缺省回退模块级单例，与 TeamService 同款）
   *
   * @param manager 子代理管理器；不传则 runWorkflow 时经 getSubagentManager() 取模块单例
   */
  constructor(private readonly manager?: SubagentManager) {}

  /**
   * 创建工作流（初始状态 IDLE，写入首条 journal）
   *
   * @param goal 目标描述
   * @param budgetSteps 步骤预算（下限 1，防止 0 预算使工作流无法执行任何步骤）
   * @returns 新建运行的 id
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
   * 追加步骤（落 PENDING 状态，并记 journal）
   *
   * @param runId 运行 id
   * @param name 步骤名
   * @returns 步骤 id；工作流已终端时返回 null（调用方据此停止追加）
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

  /** 开始步骤（pending → running；写入 startedAt） */
  startStep(runId: string, stepId: string): void {
    this.transitionStep(runId, stepId, WorkflowStepStatus.RUNNING);
  }

  /** 完成步骤（running → completed；写入 endedAt 并记录输出，缺省为 null） */
  completeStep(runId: string, stepId: string, output?: string): void {
    this.transitionStep(runId, stepId, WorkflowStepStatus.COMPLETED, output ?? null);
  }

  /** 失败步骤（running/pending → failed；写入 endedAt 并记录错误，缺省为 null） */
  failStep(runId: string, stepId: string, error?: string): void {
    this.transitionStep(runId, stepId, WorkflowStepStatus.FAILED, error ?? null);
  }

  /** 追加执行日志（轨迹；不校验状态，终端运行也可追加） */
  addJournal(runId: string, entry: string): void {
    this.mutate(runId, (current) => ({
      ...current,
      journal: [...current.journal, entry],
    }));
  }

  /** 预算软闸：已添加步骤数（含运行中/已完成）≥ 预算即视为耗尽（软闸，不抛错） */
  isBudgetExhausted(runId: string): boolean {
    const run = this.requireRun(runId);
    return run.steps.length >= run.budgetSteps;
  }

  /**
   * 完成工作流（→ completed）
   *
   * 已终端则空操作；存在 PENDING/RUNNING 步骤时抛错（须先收敛全部步骤）。
   *
   * @throws Error 存在未完成步骤（消息含步骤名列表）
   */
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

  /** 失败工作流（→ failed 终端态；记录错误说明，缺省「未知原因」；已终端则空操作） */
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

  /** 取消工作流（→ cancelled 终端态；已终端则空操作） */
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

  /** 列出全部工作流（创建时间倒序；同刻用 id 倒序兜底，保证输出确定性） */
  list(): WorkflowRun[] {
    return [...this.runs.values()].sort(
      (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
    );
  }

  /**
   * 串行编排执行：按顺序逐步委派子代理，前一步产出注入下一步上下文
   *
   * - 状态机全程跟踪：addStep → startStep → completeStep / failStep
   * - 预算软闸：已执行步数达预算后剩余步骤跳过（journal 记录，不抛错）
   * - 失败策略：halt（默认）立即 fail 终止；continue 记录失败继续后续步骤
   *   （continue 模式下失败原因同样注入下一步，供后续步骤感知）
   * - 中断：每步执行前检查 abortSignal，已中止则 cancel 工作流并跳过剩余步骤
   * - 收尾：非 halt 路径下，全部成功 → complete；存在失败 → fail（continue 带失败时整体仍 FAILED）
   *
   * @param goal 工作流目标描述
   * @param steps 步骤委派列表（run_workflow 工具侧限制 1-8 个）
   * @param workingDir 工作目录（子代理工具执行根目录）
   * @param options 编排选项（预算 / 失败策略 / 中断信号）
   * @returns 汇总结果（succeeded/failed/skipped 计数 + 终态快照）
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
        // journal/output 只存 300 字符摘要；results 保留完整产出（供工具展示）
        this.completeStep(runId, stepId, result.output.trim().slice(0, 300));
        results.push({
          name: step.name,
          agent,
          success: true,
          output: result.output,
          durationMs: result.durationMs,
        });
        // prevOutput 用完整产出（注入时再截断），供下一步拼接
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
        // continue：失败信息作为「上一步产出」注入下一步
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

  /** 汇总运行结果（succeeded/failed/skipped 计数 + 终态快照；declared 为声明步骤总数） */
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

  /** 获取单个工作流（不存在返回 undefined，不抛错） */
  get(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId);
  }

  /**
   * 步骤状态转换（内部原语）
   *
   * 三重防御：运行已终端 → 空操作；步骤不存在 → 抛错；步骤已 completed/failed → 锁定（空操作）。
   * 副作用：首次转换把运行状态从 IDLE 提升为 RUNNING（此后不再变更）；追加状态 journal。
   *
   * @param output 仅显式传入（含 null）时覆盖步骤 output；undefined 保持原值
   * @throws Error 步骤不存在
   */
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

  /** 不可变更新：整对象替换注册表条目（保持领域类型只读语义，不原地改） */
  private mutate(runId: string, updater: (current: WorkflowRun) => WorkflowRun): void {
    const run = this.requireRun(runId);
    this.runs.set(runId, updater(run));
  }

  /**
   * 取运行快照，不存在即抛错（内部前置校验）
   *
   * @throws Error 工作流不存在
   */
  private requireRun(runId: string): WorkflowRun {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new Error(`工作流不存在：${runId}`);
    }
    return run;
  }
}

/** 模块级单例（run_workflow 工具经此调用；未接入 ServiceContainer） */
export const workflowService = new WorkflowService();
