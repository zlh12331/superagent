import { z } from 'zod';
import { t } from '../../i18n';
import { TaskStatus, taskService } from '../agent/task-service';
import type { Tool, ToolContext, ToolResult } from './tool';

const TaskStopInputSchema = z.object({
  taskId: z.string().min(1).max(64),
  reason: z.string().max(200).optional(),
});

type TaskStopInput = z.infer<typeof TaskStopInputSchema>;

export function createTaskStopTool(): Tool {
  return {
    name: 'task_stop',
    description:
      '中止任务：将任务状态置为已取消（CANCELLED）。用于任务不再需要继续执行、或需要终止长期运行任务时。',
    permission: 'auto' as const,
    category: 'control' as const,
    inputSchema: TaskStopInputSchema,
    async execute(input: TaskStopInput, _ctx: ToolContext): Promise<ToolResult> {
      const ok = taskService.update(input.taskId, TaskStatus.CANCELLED);
      if (!ok) {
        return {
          title: t('tools.taskStop.failed'),
          output: `任务 ${input.taskId} 中止失败：任务不存在或已处于终端状态。`,
        };
      }
      return {
        title: t('tools.taskStop.stopped'),
        output: `任务 ${input.taskId} 已中止（CANCELLED）${input.reason !== undefined ? `，原因：${input.reason}` : ''}。`,
      };
    },
  };
}
