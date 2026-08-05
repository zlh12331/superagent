// src/main/infra/ai/tools/task-create.tool.ts
// task_create 工具：创建任务条目（对齐 qwen task_create 工具语义）
// ──────────────────────────────────────────────────────────────
// 设计：
// - 任务条目绑定当前会话（ctx.sessionId）；kind=agent（委派工作单元）
// - permission='auto'：纯元数据写入，无副作用风险
// - 集成 TaskService（sqlite 持久化）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import { TaskKind, taskService } from '../task-service';
import type { Tool, ToolContext, ToolResult } from '../tool';

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
    category: 'exec',
    execute: async (input: TaskCreateInput, ctx: ToolContext): Promise<ToolResult> => {
      const taskId = taskService.create(ctx.sessionId, TaskKind.AGENT, input.description);
      return {
        title: `任务已创建: ${input.description.slice(0, 30)}`,
        output: `任务创建成功：${taskId}\n描述：${input.description}`,
      };
    },
  };
}
