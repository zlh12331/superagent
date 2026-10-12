// run-workflow.tool.ts：run_workflow 工具——多步工作流（workflow-service 承载）
import { z } from 'zod';
import { t } from '../../i18n';
import { workflowService } from '../agent/workflow-service';
import type { Tool, ToolContext, ToolResult } from './tool';

const RunWorkflowInputSchema = z.object({
  goal: z.string().min(1).max(500),
  steps: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        task: z.string().min(1).max(2000),
        agent: z.string().min(1).max(100).optional(),
      }),
    )
    .min(1)
    .max(8),
  onFailure: z.enum(['halt', 'continue']).optional(),
});

type RunWorkflowInput = z.infer<typeof RunWorkflowInputSchema>;

const STATUS_LABELS: Record<string, string> = {
  completed: '✅ 已完成',
  failed: '❌ 失败',
  cancelled: '⏹ 已取消',
};

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
        const stepTasks = input.steps.map((step) => ({
          name: step.name,
          task: step.task,
          ...(step.agent !== undefined ? { agent: step.agent } : {}),
        }));
        const result = await workflowService.runWorkflow(input.goal, stepTasks, ctx.workingDir, {
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
          title:
            result.status === 'completed'
              ? t('tools.runWorkflow.completed', { goal: input.goal.slice(0, 30) })
              : t('tools.runWorkflow.ended', { goal: input.goal.slice(0, 30) }),
          output: lines.join('\n\n'),
        };
      } catch (err: unknown) {
        return {
          title: t('tools.runWorkflow.failed'),
          output: `工作流执行失败：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
