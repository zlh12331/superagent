// task-update.tool.ts：task_update 工具——更新任务状态
import { z } from 'zod';
import { t } from '../../i18n';
import { TaskStatus, taskService } from '../agent/task-service';
import type { Tool, ToolContext, ToolResult } from './tool';

const TaskUpdateInputSchema = z.object({
  taskId: z.string().min(1).max(64),
  status: z.enum([
    TaskStatus.PENDING,
    TaskStatus.RUNNING,
    TaskStatus.COMPLETED,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
  ]),
});

type TaskUpdateInput = z.infer<typeof TaskUpdateInputSchema>;

export function createTaskUpdateTool(): Tool<TaskUpdateInput> {
  return {
    name: 'task_update',
    description:
      '更新任务状态（pending/running/completed/failed/cancelled）。任务进入终端状态（completed/failed/cancelled）后不可再改变。',
    inputSchema: TaskUpdateInputSchema,
    permission: 'auto',
    category: 'control',
    execute: async (input: TaskUpdateInput, _ctx: ToolContext): Promise<ToolResult> => {
      const ok = taskService.update(input.taskId, input.status);
      if (!ok) {
        return {
          title: t('tools.taskUpdate.failed'),
          output: `任务 ${input.taskId} 更新为 ${input.status} 失败：任务不存在或已处于终端状态。`,
        };
      }
      return {
        title: t('tools.taskUpdate.status', { status: input.status }),
        output: `任务 ${input.taskId} 已更新为 ${input.status}。`,
      };
    },
  };
}
