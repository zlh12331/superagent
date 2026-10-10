import { z } from 'zod';
import { t } from '../../i18n';
import { TaskKind, taskService } from '../agent/task-service';
import type { Tool, ToolContext, ToolResult } from './tool';

/** task_create 入参 */
const TaskCreateInputSchema = z.object({
  /** 任务描述（任务面板展示） */
  description: z.string().min(1).max(200),
});

type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>;

/**
 * 创建 task_create 工具（依赖模块级 TaskService 单例）
 */
export function createTaskCreateTool(): Tool<TaskCreateInput> {
  return {
    name: 'task_create',
    description:
      '创建一条任务记录（绑定当前会话，状态 pending）。用于把子任务登记到任务面板，供后续 task_list / task_update 跟踪。',
    inputSchema: TaskCreateInputSchema,
    permission: 'auto',
    category: 'control',
    execute: async (input: TaskCreateInput, ctx: ToolContext): Promise<ToolResult> => {
      const taskId = taskService.create(ctx.sessionId, TaskKind.AGENT, input.description);
      return {
        title: t('tools.taskCreate.created', { desc: input.description.slice(0, 30) }),
        output: `任务创建成功：${taskId}\n描述：${input.description}`,
      };
    },
  };
}
