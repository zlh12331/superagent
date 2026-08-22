// src/main/infra/ai/tools/run-workflow.tool.ts
// run_workflow 工具：串行多步工作流编排（对齐 qwen Workflow 工具语义）
// ──────────────────────────────────────────────────────────────
// 设计：
// - permission='ask' / category='exec'：子代理回合可能产生副作用（写文件），
//   保守审批（与 run_subagent / run_team 一致）
// - 串行执行 + 上一步产出注入下一步上下文：面向依赖链任务
//   （先方案 → 再实现 → 后审查），与 run_team 的并行独立委派互补
// - 状态机/预算软闸/journal 全程跟踪在 WorkflowService（本工具保持薄壳）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import { workflowService } from '../agent/workflow-service';
import type { Tool, ToolContext, ToolResult } from './tool';

/** run_workflow 入参 */
const RunWorkflowInputSchema = z.object({
  /** 工作流目标描述 */
  goal: z.string().min(1).max(500),
  /** 步骤委派列表（1-8 个；按顺序串行执行） */
  steps: z
    .array(
      z.object({
        /** 步骤名（简短，展示与日志用） */
        name: z.string().min(1).max(100),
        /** 委派任务描述（自动附加前一步产出作为上下文） */
        task: z.string().min(1).max(2000),
        /** 子代理名（general / code_review / plan 等；缺省 general） */
        agent: z.string().min(1).max(100).optional(),
      }),
    )
    .min(1)
    .max(8),
  /** 单步失败策略：halt 中止后续（默认）/ continue 继续执行剩余步骤 */
  onFailure: z.enum(['halt', 'continue']).optional(),
});

type RunWorkflowInput = z.infer<typeof RunWorkflowInputSchema>;

/** 工作流终态中文标签 */
const STATUS_LABELS: Record<string, string> = {
  completed: '✅ 已完成',
  failed: '❌ 失败',
  cancelled: '⏹ 已取消',
};

/**
 * 创建 run_workflow 工具（依赖模块级 WorkflowService 单例）
 */
export function createRunWorkflowTool(): Tool<RunWorkflowInput> {
  return {
    name: 'run_workflow',
    description:
      '串行执行多步工作流：按顺序把每个步骤委派给子代理，前一步产出自动注入下一步作为上下文。适合存在依赖链的任务（先方案设计 → 再实现 → 后审查）。步骤 1-8 个；单步失败默认中止后续（可选继续）；父回合中断时取消剩余步骤。与 run_team（并行独立任务）互补。',
    inputSchema: RunWorkflowInputSchema,
    permission: 'ask',
    category: 'exec',
    execute: async (input: RunWorkflowInput, ctx: ToolContext): Promise<ToolResult> => {
      try {
        // exactOptionalPropertyTypes：zod 推导的 agent?: string|undefined 需条件展开
        const stepTasks = input.steps.map((step) => ({
          name: step.name,
          task: step.task,
          ...(step.agent !== undefined ? { agent: step.agent } : {}),
        }));
        const result = await workflowService.runWorkflow(input.goal, stepTasks, ctx.workingDir, {
          // exactOptionalPropertyTypes：可选字段条件展开
          ...(input.onFailure !== undefined ? { onFailure: input.onFailure } : {}),
          abortSignal: ctx.abortSignal,
        });
        const statusLabel = STATUS_LABELS[result.status] ?? result.status;
        const skipNote =
          result.skipped > 0 ? `\n⚠ ${result.skipped} 个步骤未执行（预算软闸或中断）` : '';
        const lines = [
          `【工作流${statusLabel}】成功 ${result.succeeded} / 失败 ${result.failed} / 跳过 ${result.skipped}${skipNote}`,
          '',
          ...result.steps.map((step) => {
            const icon = step.success ? '✅' : '❌';
            return [
              `${icon} ${step.name}（${step.agent} · ${Math.round(step.durationMs / 1000)}s）`,
              step.output.trim().slice(0, 2000),
            ].join('\n');
          }),
        ];
        return {
          title: `工作流执行${result.status === 'completed' ? '完成' : '结束'}: ${input.goal.slice(0, 30)}`,
          output: lines.join('\n\n'),
        };
      } catch (err: unknown) {
        return {
          title: '工作流执行失败',
          output: `工作流执行失败：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
